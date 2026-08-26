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
  type ReviewAgentHarness,
  authoringSessionKey,
  parseAuthoringSessionKey,
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
import { createTutorialAgentSession } from "../tutorial-agent-session";
import { writePrivateJsonAtomic } from "./desktop-paths";

const execFilePromise = promisify(execFile);
const TUTORIAL_STATUS_VERSION = 1;
/* Version 6 adds the database and Get help stops to the bundled document.
   Older tutorial records are re-materialized on first open. */
const TUTORIAL_STAMP_VERSION = 6;

export interface TutorialStamp {
  version: 6;
  reviewUuid: string;
}

export interface TutorialStatus {
  version: 1;
  reviewUuid: string | null;
}

export interface TutorialService {
  status(): Promise<TutorialStatus>;
  /** The hidden system Review record. Null when absent or invalid. */
  find(): Promise<StoredReview | null>;
  /** Returns the ready-to-mount tutorial Review. Materializes the shipped
      repo and a sealed revision when absent or invalid. Compilation remains
      unnecessary because the document and map bundles ship precompiled. */
  prepare(agent: ReviewAgentHarness): Promise<StoredReview>;
  cleanup(): Promise<void>;
}

export function createTutorialService(input: {
  packageRoot: string;
  deleteReview(review: StoredReview): Promise<void>;
  createAgentSession?: typeof createTutorialAgentSession;
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

  const readValidState = async (): Promise<{
    stamp: TutorialStamp;
    review: StoredReview;
  } | null> => {
    const stamp = await readTutorialStamp(stampPath);
    if (!stamp) return null;
    const review = await findTutorialReview(stamp.reviewUuid).catch(() => null);
    if (!review || !(await isValidTutorialReview(review, sampleRoot))) {
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

    async find() {
      const state = await readValidState();
      return state?.review ?? null;
    },

    async prepare(agent) {
      const current = await readValidState();
      if (current) return current.review;

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
      const sourceAgent = await (
        input.createAgentSession ?? createTutorialAgentSession
      )({
        harness: agent,
        rootPath: sampleRoot,
      });
      const sourceSession = authoringSessionKey(sourceAgent);
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
      await Promise.all([
        cp(
          path.join(assetsRoot, "review.mdx"),
          path.join(candidate.dir, "review.mdx"),
        ),
        cp(
          path.join(assetsRoot, "data.ts"),
          path.join(candidate.dir, "data.ts"),
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
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as {
    headCommit?: unknown;
    baseCommit?: unknown;
  };
  if (
    typeof value.headCommit !== "string" ||
    typeof value.baseCommit !== "string"
  ) {
    throw new Error("Tutorial software-map manifest is invalid.");
  }
  return { headCommit: value.headCommit, baseCommit: value.baseCommit };
}

async function isValidTutorialReview(
  review: StoredReview,
  sampleRoot: string,
): Promise<boolean> {
  if (!(await isManagedTutorialPath(review.review.worktreePath, sampleRoot))) {
    return false;
  }
  if (
    review.review.visibility !== "system" ||
    !parseAuthoringSessionKey(review.review.sourceSession) ||
    !review.review.presentedDocumentRevision ||
    !review.review.presentedSoftwareMapRevision
  ) {
    return false;
  }
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
    const value = JSON.parse(await readFile(stampPath, "utf8")) as {
      version?: unknown;
      reviewUuid?: unknown;
    };
    return value.version === TUTORIAL_STAMP_VERSION &&
      typeof value.reviewUuid === "string"
      ? { version: TUTORIAL_STAMP_VERSION, reviewUuid: value.reviewUuid }
      : null;
  } catch {
    return null;
  }
}

async function requireTutorialAssets(assetsRoot: string): Promise<void> {
  const required = [
    "sample-service",
    "review.mdx",
    "data.ts",
    "software-map.ts",
    "git-stub/HEAD",
    ".bundle/document/review-document.js",
    ".bundle/document/manifest.json",
    ".bundle/software-map/head-map.js",
    ".bundle/software-map/base-map.js",
    ".bundle/software-map/manifest.json",
  ];
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
