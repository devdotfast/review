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
  DISABLED_REVIEW_SOURCE_SESSION,
  type StoredReview,
  createReviewDir,
  createReviewUuid,
  listReviews,
  readStoredReview,
  reviewTitleFromDocument,
} from "../review-home";
import {
  pinReviewSourceHeadRef,
  reviewSourceHeadRef,
} from "../review-source-ref";
import { devReviewHome } from "../review-storage";
import { writePrivateJsonAtomic } from "./desktop-paths";

const execFilePromise = promisify(execFile);
const TUTORIAL_STATUS_VERSION = 1;
/* Version 2 marks the precompiled-assets layout. A version-1 stamp (the old
   compile-on-open flow) reads as invalid, so the first open after an upgrade
   cleans up and re-materializes. */
const TUTORIAL_STAMP_VERSION = 2;

export interface TutorialStamp {
  version: 2;
  reviewUuid: string;
}

export interface TutorialStatus {
  version: 1;
  reviewUuid: string | null;
}

export interface TutorialService {
  status(): Promise<TutorialStatus>;
  /** The tutorial Review record, read from the tutorial root — never the
      review store. Null when absent or invalid. */
  find(): Promise<StoredReview | null>;
  /** Returns the ready-to-mount tutorial Review. Materializes the shipped
      repo and record when absent or invalid. Never compiles or seals:
      the document and map bundles ship precompiled in app resources. */
  prepare(): Promise<StoredReview>;
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

  // The tutorial Review lives under ~/.dev/tutorial/reviews/<uuid>, not the
  // review store, so `listReviews` (Home) never sees it.
  const findTutorialReview = async (
    uuid: string,
  ): Promise<StoredReview | null> => {
    const loaded = await readStoredReview(
      path.join(tutorialRoot, "reviews", uuid),
    );
    return "error" in loaded || loaded.review.uuid !== uuid ? null : loaded;
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
    if (!manifest || manifest.headCommit !== review.review.sourceCommit) {
      return null;
    }
    return { stamp, review };
  };

  const cleanup = async (): Promise<void> => {
    const listed = await listReviews();
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

    async prepare() {
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
      const created = await createReviewDir({
        uuid,
        reviewsHomePath: tutorialRoot,
        worktreePath: sampleRoot,
        baseRef: "main",
        baseCommit: head.commit,
        sourceCommit: head.commit,
        sourceIdentity: { kind: "git-branch", name: "main" },
        sourceSession: DISABLED_REVIEW_SOURCE_SESSION,
        title: await reviewTitleFromDocument(
          path.join(assetsRoot, "review.mdx"),
        ),
      });
      // The tutorial is never published: the shipped bundle is the
      // presentation, so the record is reviewable from creation.
      const review: StoredReview = {
        ...created,
        review: {
          ...created.review,
          status: "awaiting-review",
          lastPublishedAt: new Date().toISOString(),
        },
      };
      await writePrivateJsonAtomic(
        path.join(review.dir, "review.json"),
        review.review,
      );
      // The state copy of the document is the comment/thread target.
      await Promise.all([
        cp(
          path.join(assetsRoot, "review.mdx"),
          path.join(review.dir, "review.mdx"),
        ),
        cp(path.join(assetsRoot, "data.ts"), path.join(review.dir, "data.ts")),
      ]);
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
): Promise<{ headCommit: string }> {
  const manifestPath = path.join(
    assetsRoot,
    ".bundle",
    "software-map",
    "manifest.json",
  );
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as {
    headCommit?: unknown;
  };
  if (typeof value.headCommit !== "string") {
    throw new Error("Tutorial software-map manifest is invalid.");
  }
  return { headCommit: value.headCommit };
}

async function isValidTutorialReview(
  review: StoredReview,
  sampleRoot: string,
): Promise<boolean> {
  if (!(await isManagedTutorialPath(review.review.worktreePath, sampleRoot))) {
    return false;
  }
  const sourceCommit = review.review.sourceCommit;
  if (!sourceCommit || review.review.baseCommit !== sourceCommit) return false;
  const [head, count] = await Promise.all([
    resolveRevision(sampleRoot, "HEAD").catch(() => null),
    runGit(sampleRoot, ["rev-list", "--count", "HEAD"]).catch(() => ""),
  ]);
  return head?.commit === sourceCommit && count.trim() === "1";
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
