import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveRevision } from "@dev.fast/local-vcs";
import {
  type JsonValue,
  isJsonObject,
  jsonProperty,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import {
  type ReviewAgentHarness,
  freshSourceSessionKey,
  parseAuthoringSessionKey,
  parseFreshSourceSessionHarness,
} from "../authoring-session";
import {
  type StoredReview,
  createReviewDir,
  createReviewUuid,
  findReview,
  listReviews,
  reviewTitleFromDocument,
  sealReviewCandidate,
} from "../review-home";
import {
  pinReviewSourceHeadRef,
  reviewSourceHeadRef,
} from "../review-source-ref";
import { devReviewHome } from "../review-storage";
import { writePrivateJsonAtomic } from "./desktop-paths";

const execFilePromise = promisify(execFile);
const TUTORIAL_STATUS_VERSION = 1;
/* Version 8 adds the representative authoring conversation and its lazy
   source-session handoff. Older records are re-materialized on first open. */
const TUTORIAL_STAMP_VERSION = 8;

export interface TutorialStamp {
  version: 8;
  reviewUuid: string;
}

export interface TutorialStatus {
  version: 1;
  reviewUuid: string | null;
}

export interface TutorialService {
  status(): Promise<TutorialStatus>;
  /** True when the UUID belongs to the tutorial stamp or managed repository. */
  referencesReview(reviewUuid: string): Promise<boolean>;
  /** The hidden system Review record. Null when absent or invalid. */
  find(): Promise<StoredReview | null>;
  /** Returns the ready-to-mount tutorial Review. Materializes the shipped
      repo and a sealed revision when absent or invalid. Compilation remains
      unnecessary because the document and map bundles ship precompiled. */
  prepare(
    agent: ReviewAgentHarness,
    options?: { beforeReset(): Promise<void> },
  ): Promise<StoredReview>;
  cleanup(): Promise<void>;
}

export function createTutorialService(input: {
  packageRoot: string;
  deleteReview(review: StoredReview): Promise<void>;
}): TutorialService {
  const tutorialRoot = path.join(devReviewHome(), "tutorial");
  const sampleRoot = path.join(tutorialRoot, "sample-service");
  const stampPath = path.join(tutorialRoot, "stamp.json");
  const assetsRoot = path.join(input.packageRoot, "tutorial");

  const findTutorialReview = async (
    uuid: string,
  ): Promise<StoredReview | null> => {
    const loaded = await findReview(uuid);
    return loaded?.review.visibility === "system" ? loaded : null;
  };

  const readValidState = async (
    expectedHarness?: ReviewAgentHarness,
  ): Promise<{
    stamp: TutorialStamp;
    review: StoredReview;
  } | null> => {
    const stamp = await readTutorialStamp(stampPath);
    if (!stamp) return null;
    const review = await findTutorialReview(stamp.reviewUuid).catch(() => null);
    if (
      !review ||
      !(await isValidTutorialReview(review, sampleRoot, expectedHarness))
    ) {
      return null;
    }
    // An app update ships new bundles pinned to a new commit. A record
    // bound to the old commit is stale: re-materialize instead of serving
    // new bundles against the old repository.
    const manifest = await readShippedMapManifest(assetsRoot).catch(() => null);
    if (
      !manifest ||
      manifest.headCommit !== review.review.sourceCommit ||
      manifest.baseCommit !== review.review.baseCommit
    ) {
      return null;
    }
    return { stamp, review };
  };

  const cleanup = async (): Promise<void> => {
    const listed = await listReviews({ includeSystem: true });
    for (const review of listed.reviews) {
      if (await isManagedTutorialPath(review.review.worktreePath, sampleRoot)) {
        await input.deleteReview(review);
      }
    }
    await rm(tutorialRoot, { recursive: true, force: true });
  };

  return {
    async status() {
      const state = await readValidState();
      return {
        version: TUTORIAL_STATUS_VERSION,
        reviewUuid: state?.stamp.reviewUuid ?? null,
      };
    },

    async referencesReview(reviewUuid) {
      const stamp = await readTutorialStamp(stampPath);
      if (stamp?.reviewUuid === reviewUuid) return true;
      const review = await findTutorialReview(reviewUuid).catch(() => null);
      return review
        ? isManagedTutorialPath(review.review.worktreePath, sampleRoot)
        : false;
    },

    async find() {
      const state = await readValidState();
      return state?.review ?? null;
    },

    async prepare(agent, options) {
      const current = await readValidState(agent);
      if (current) return current.review;

      await options?.beforeReset();
      await cleanup();
      await requireTutorialAssets(assetsRoot);
      await materializeSampleRepository({
        assetsRoot,
        tutorialRoot,
        sampleRoot,
      });

      const head = await resolveRevision(sampleRoot, "main");
      if (!head) {
        throw new Error("Tutorial repository has no main commit.");
      }
      const manifest = await readShippedMapManifest(assetsRoot);
      if (manifest.headCommit !== head.commit) {
        throw new Error(
          `Tutorial assets are inconsistent: repository HEAD ${head.commit} does not match the shipped bundle commit ${manifest.headCommit}.`,
        );
      }

      const uuid = createReviewUuid();
      await pinReviewSourceHeadRef(
        sampleRoot,
        reviewSourceHeadRef(uuid),
        head.commit,
      );
      const sourceSession = freshSourceSessionKey(agent);
      const created = await createReviewDir({
        uuid,
        visibility: "system",
        worktreePath: sampleRoot,
        baseRef: "main~1",
        baseCommit: manifest.baseCommit,
        sourceCommit: head.commit,
        sourceIdentity: { kind: "git-branch", name: "main" },
        sourceSession,
        title: await reviewTitleFromDocument(
          path.join(assetsRoot, "review.mdx"),
        ),
      });
      // Store the shipped source and precompiled bundles as a genuine Review
      // revision. Opening can then use the same materialization and session
      // path as any published Review.
      const publishedAt = new Date().toISOString();
      const candidate: StoredReview = {
        ...created,
        review: {
          ...created.review,
          status: "awaiting-review",
          lastPublishedAt: publishedAt,
        },
      };
      await writePrivateJsonAtomic(
        path.join(candidate.dir, "review.json"),
        candidate.review,
      );
      const runtimeManifest = await readTutorialRuntimeManifest(assetsRoot);
      await Promise.all([
        ...runtimeManifest.reviewFiles.map((entry) =>
          cp(path.join(assetsRoot, entry), path.join(candidate.dir, entry)),
        ),
        cp(
          path.join(assetsRoot, ".bundle"),
          path.join(candidate.dir, ".bundle"),
          {
            recursive: true,
          },
        ),
      ]);
      const revision = await sealReviewCandidate(
        candidate.dir,
        "Materialize bundled tutorial Review",
      );
      const review: StoredReview = {
        ...candidate,
        review: {
          ...candidate.review,
          presentedDocumentRevision: revision,
          presentedSoftwareMapRevision: revision,
        },
      };
      await writePrivateJsonAtomic(
        path.join(review.dir, "review.json"),
        review.review,
      );
      await writePrivateJsonAtomic(stampPath, {
        version: TUTORIAL_STAMP_VERSION,
        reviewUuid: review.review.uuid,
      } satisfies TutorialStamp);
      return review;
    },

    cleanup,
  };
}

/* Copies the shipped sample tree and places the shipped git directory as its
   `.git` — npm packing strips `.git` names, so it ships as `git-stub`. No
   git commands run: the repository arrives ready-made. */
async function materializeSampleRepository(input: {
  assetsRoot: string;
  tutorialRoot: string;
  sampleRoot: string;
}): Promise<void> {
  await mkdir(input.tutorialRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = path.join(
    input.tutorialRoot,
    `.sample-service-${crypto.randomUUID()}`,
  );
  try {
    await cp(path.join(input.assetsRoot, "sample-service"), temporaryRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp(
      path.join(input.assetsRoot, "git-stub"),
      path.join(temporaryRoot, ".git"),
      { recursive: true },
    );
    await rename(temporaryRoot, input.sampleRoot);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error(
      `Tutorial repository materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readShippedMapManifest(
  assetsRoot: string,
): Promise<{ headCommit: string; baseCommit: string }> {
  const manifestPath = path.join(
    assetsRoot,
    ".bundle",
    "software-map",
    "manifest.json",
  );
  const value = parseJsonText(await readFile(manifestPath, "utf8"));
  const manifest = isJsonObject(value) ? value : undefined;
  const headCommit =
    manifest && jsonString(jsonProperty(manifest, "headCommit"));
  const baseCommit =
    manifest && jsonString(jsonProperty(manifest, "baseCommit"));
  if (headCommit === undefined || baseCommit === undefined) {
    throw new Error("Tutorial software-map manifest is invalid.");
  }
  return { headCommit, baseCommit };
}

async function isValidTutorialReview(
  review: StoredReview,
  sampleRoot: string,
  expectedHarness?: ReviewAgentHarness,
): Promise<boolean> {
  if (!(await isManagedTutorialPath(review.review.worktreePath, sampleRoot))) {
    return false;
  }
  if (
    review.review.visibility !== "system" ||
    !(
      parseFreshSourceSessionHarness(review.review.sourceSession) ||
      parseAuthoringSessionKey(review.review.sourceSession)
    ) ||
    !review.review.presentedDocumentRevision ||
    !review.review.presentedSoftwareMapRevision
  ) {
    return false;
  }
  const storedHarness =
    parseAuthoringSessionKey(review.review.sourceSession)?.harness ??
    parseFreshSourceSessionHarness(review.review.sourceSession);
  if (expectedHarness && storedHarness !== expectedHarness) return false;
  const sourceCommit = review.review.sourceCommit;
  if (!sourceCommit || review.review.baseCommit === sourceCommit) return false;
  const [head, base, count] = await Promise.all([
    resolveRevision(sampleRoot, "HEAD").catch(() => null),
    resolveRevision(sampleRoot, "HEAD^").catch(() => null),
    runGit(sampleRoot, ["rev-list", "--count", "HEAD"]).catch(() => ""),
  ]);
  return (
    head?.commit === sourceCommit &&
    base?.commit === review.review.baseCommit &&
    count.trim() === "2"
  );
}

async function readTutorialStamp(
  stampPath: string,
): Promise<TutorialStamp | null> {
  try {
    const value = parseJsonText(await readFile(stampPath, "utf8"));
    if (!isJsonObject(value)) return null;
    const reviewUuid = jsonString(jsonProperty(value, "reviewUuid"));
    return jsonProperty(value, "version") === TUTORIAL_STAMP_VERSION &&
      reviewUuid !== undefined
      ? { version: TUTORIAL_STAMP_VERSION, reviewUuid }
      : null;
  } catch {
    return null;
  }
}

async function requireTutorialAssets(assetsRoot: string): Promise<void> {
  const { requiredPaths: required } =
    await readTutorialRuntimeManifest(assetsRoot);
  const missing: string[] = [];
  for (const entry of required) {
    try {
      await stat(path.join(assetsRoot, entry));
    } catch {
      missing.push(entry);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Tutorial runtime assets are missing: ${missing.join(", ")}.`,
    );
  }
}

interface TutorialRuntimeManifest {
  version: 1;
  reviewFiles: string[];
  requiredPaths: string[];
}

async function readTutorialRuntimeManifest(
  assetsRoot: string,
): Promise<TutorialRuntimeManifest> {
  const value = parseJsonText(
    await readFile(path.join(assetsRoot, "runtime-manifest.json"), "utf8"),
  );
  const manifest = isJsonObject(value) ? value : undefined;
  const reviewFiles = manifest && jsonProperty(manifest, "reviewFiles");
  const requiredPaths = manifest && jsonProperty(manifest, "requiredPaths");
  if (
    !manifest ||
    jsonProperty(manifest, "version") !== 1 ||
    !isRelativePathList(reviewFiles) ||
    !isRelativePathList(requiredPaths) ||
    reviewFiles.some((entry) => !requiredPaths.includes(entry))
  ) {
    throw new Error("Tutorial runtime manifest is invalid.");
  }
  return {
    version: 1,
    reviewFiles: [...new Set(reviewFiles)],
    requiredPaths: [...new Set(requiredPaths)],
  };
}

function isRelativePathList(
  entries: JsonValue | undefined,
): entries is string[] {
  return (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.every((entry) => {
      const relativePath = jsonString(entry);
      return (
        relativePath !== undefined &&
        relativePath.length > 0 &&
        !path.isAbsolute(relativePath) &&
        !relativePath.split(/[\\/]/u).includes("..")
      );
    })
  );
}

async function isManagedTutorialPath(
  candidate: string,
  root: string,
): Promise<boolean> {
  const [canonicalCandidate, canonicalRoot] = await Promise.all([
    realpath(candidate).catch(() => path.resolve(candidate)),
    realpath(root).catch(() => path.resolve(root)),
  ]);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}
