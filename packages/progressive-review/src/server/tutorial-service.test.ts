import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ReviewArtifactKind,
  readReviewArtifactBytes,
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
  reviewArtifactPath,
} from "../review-artifact-store";
import { type StoredReview, findReview, listReviews } from "../review-home";
import { readPublication } from "../review-state-db";
import { createTutorialService } from "./tutorial-service";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const execFilePromise = promisify(execFile);
const DOCUMENT_BUNDLE_PATH = path.join(
  ".bundle",
  "document",
  "review-document.json",
);

afterEach(() => vi.unstubAllEnvs());

describe("tutorial service", () => {
  it.each(["missing", "invalid-json", "invalid-schema"])(
    "rejects a saved tutorial with %s document data",
    async (kind) => {
      const home = await mkdtemp(
        path.join(os.tmpdir(), "review-tutorial-invalid-"),
      );
      vi.stubEnv("DEV_REVIEW_HOME", home);
      const service = tutorialService(packageRoot);
      try {
        const saved = await service.prepare("claude-code");
        expect((await service.status()).reviewUuid).toBe(saved.review.uuid);
        const documentPath = reviewArtifactPath(
          saved.dir,
          "document",
          artifactHash(saved, "document"),
        );
        if (kind === "missing") await rm(documentPath);
        else
          await writeFile(documentPath, kind === "invalid-json" ? "{" : "{}");
        expect(await service.status()).toEqual({
          version: 1,
          reviewUuid: null,
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("republishes the shipped document after a tutorial edit without changing sample commits", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-copy-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const assets = path.join(home, "package");
    await cp(
      path.join(packageRoot, "tutorial"),
      path.join(assets, "tutorial"),
      {
        recursive: true,
      },
    );
    const service = tutorialService(assets);
    try {
      const before = await service.prepare("claude-code");
      // An app update ships new document bytes against the same commits.
      const shippedDocument = path.join(
        assets,
        "tutorial",
        DOCUMENT_BUNDLE_PATH,
      );
      const edited = `${(await readFile(shippedDocument, "utf8")).trimEnd()}\n\n`;
      await writeFile(shippedDocument, edited, "utf8");

      expect((await service.status()).reviewUuid).toBeNull();
      const after = await service.prepare("claude-code");
      expect(after.review.uuid).not.toBe(before.review.uuid);
      expect(after.review.sourceCommit).toBe(before.review.sourceCommit);
      await expect(publishedArtifact(after, "document")).resolves.toBe(edited);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("materializes a hidden Review whose publications hold the shipped bundles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = tutorialService(packageRoot);

    try {
      const review = await service.prepare("claude-code");

      expect(review.dir).toBe(path.join(home, "reviews", review.review.uuid));
      expect(review.review).toMatchObject({
        visibility: "system",
        sourceSession: "fresh:claude-code",
        status: "awaiting-review",
        title: "Review Desktop: three-minute tour",
        presentedDocumentRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
        presentedSoftwareMapRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      expect(review.review.presentedSoftwareMapRevision).not.toBe(
        review.review.presentedDocumentRevision,
      );
      expect(review.review.agentSessions).toBeUndefined();
      expect(publicationRecord(review, "document")).toMatchObject({
        kind: "document",
        operation: "tutorial",
        title: "Review Desktop: three-minute tour",
        titleSource: "document",
        baseRef: "main~1",
        baseCommit: review.review.baseCommit,
        sourceCommit: review.review.sourceCommit,
        pairedMapPublicationId: review.review.presentedSoftwareMapRevision,
      });
      expect(publicationRecord(review, "map")).toMatchObject({
        kind: "map",
        operation: "tutorial",
        headCommit: review.review.sourceCommit,
        baseCommit: review.review.baseCommit,
        validatedDocumentPublicationId: null,
      });
      // The artifacts hold the shipped bytes and read back as the bundles the
      // desktop serves.
      const shippedDocument = await readFile(
        path.join(packageRoot, "tutorial", DOCUMENT_BUNDLE_PATH),
        "utf8",
      );
      await expect(publishedArtifact(review, "document")).resolves.toBe(
        shippedDocument,
      );
      await expect(
        readReviewDocumentArtifact(
          review.dir,
          artifactHash(review, "document"),
        ),
      ).resolves.toMatchObject({ json: shippedDocument });
      await expect(
        readReviewSoftwareMapArtifact(review.dir, artifactHash(review, "map")),
      ).resolves.toMatchObject({
        headCommit: review.review.sourceCommit,
        baseCommit: review.review.baseCommit,
      });
      await expect(
        readFile(path.join(review.dir, "authoring-conversation.json"), "utf8"),
      ).resolves.toContain('"title": "How this Review was made"');

      await expect(listReviews()).resolves.toMatchObject({ reviews: [] });
      await expect(listReviews({ includeSystem: true })).resolves.toMatchObject(
        { reviews: [{ review: { uuid: review.review.uuid } }] },
      );
      // Nothing about the tutorial reads the Review's own Git repository.
      await rm(path.join(review.dir, ".git"), { recursive: true, force: true });
      await expect(service.status()).resolves.toEqual({
        version: 1,
        reviewUuid: review.review.uuid,
      });
      await expect(service.find()).resolves.not.toBeNull();

      await service.cleanup();
      await expect(findReview(review.review.uuid)).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reinstalls a deleted artifact without republishing the Review", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = tutorialService(packageRoot);

    try {
      const before = await service.prepare("claude-code");
      const documentArtifact = reviewArtifactPath(
        before.dir,
        "document",
        artifactHash(before, "document"),
      );
      await rm(documentArtifact, { force: true });
      await expect(publishedArtifact(before, "document")).resolves.toBeNull();

      const after = await service.prepare("claude-code");
      expect(after.review.uuid).toBe(before.review.uuid);
      expect(after.review.presentedDocumentRevision).toBe(
        before.review.presentedDocumentRevision,
      );
      await expect(publishedArtifact(after, "document")).resolves.toBe(
        await readFile(
          path.join(packageRoot, "tutorial", DOCUMENT_BUNDLE_PATH),
          "utf8",
        ),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds a fresh marker when the installed harness changes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = tutorialService(packageRoot);

    try {
      const codex = await service.prepare("codex");
      const pi = await service.prepare("pi");

      expect(pi.review.uuid).not.toBe(codex.review.uuid);
      expect(pi.review.sourceSession).toBe("fresh:pi");
      await expect(findReview(codex.review.uuid)).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("cleans up a managed tutorial Review its record can no longer describe", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = tutorialService(packageRoot);

    try {
      await service.prepare("codex");
      const strandedUuid = "33333333-3333-4333-8333-333333333333";
      const strandedDir = path.join(home, "reviews", strandedUuid);
      await mkdir(strandedDir, { recursive: true });
      await writeFile(
        path.join(strandedDir, "review.json"),
        `${JSON.stringify({
          uuid: strandedUuid,
          worktreePath: path.join(home, "tutorial", "sample-service"),
        })}\n`,
        "utf8",
      );
      await expect(listReviews({ includeSystem: true })).resolves.toMatchObject(
        { errors: [{ reviewDir: strandedDir }] },
      );

      await service.cleanup();
      await expect(listReviews({ includeSystem: true })).resolves.toMatchObject(
        { errors: [], reviews: [] },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails closed when repository history is invalid or Git fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = tutorialService(packageRoot);
    const repository = path.join(home, "tutorial", "sample-service");

    try {
      await service.prepare("codex");
      await execFilePromise("git", ["commit", "--allow-empty", "-m", "extra"], {
        cwd: repository,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Review Tutorial",
          GIT_AUTHOR_EMAIL: "tutorial@dev.fast",
          GIT_COMMITTER_NAME: "Review Tutorial",
          GIT_COMMITTER_EMAIL: "tutorial@dev.fast",
        },
      });
      await expect(service.find()).resolves.toBeNull();

      await service.prepare("codex");
      const gitDir = path.join(repository, ".git");
      const hiddenGitDir = path.join(repository, ".git-unavailable");
      await rename(gitDir, hiddenGitDir);
      try {
        await expect(service.find()).resolves.toBeNull();
      } finally {
        await rename(hiddenGitDir, gitDir);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function tutorialService(root: string) {
  return createTutorialService({
    packageRoot: root,
    deleteReview: async (review) => {
      await rm(review.dir, { recursive: true, force: true });
    },
  });
}

function publicationId(review: StoredReview, kind: ReviewArtifactKind): string {
  const id =
    kind === "document"
      ? review.review.presentedDocumentRevision
      : review.review.presentedSoftwareMapRevision;
  if (!id) throw new Error(`Tutorial Review has no presented ${kind}.`);
  return id;
}

function publicationRecord(review: StoredReview, kind: ReviewArtifactKind) {
  const row = readPublication(review.dir, publicationId(review, kind), kind);
  if (!row) throw new Error(`No ${kind} publication row for the tutorial.`);
  return row.record;
}

function artifactHash(review: StoredReview, kind: ReviewArtifactKind): string {
  const row = readPublication(review.dir, publicationId(review, kind), kind);
  if (!row?.artifactHash)
    throw new Error(`No ${kind} artifact hash for the tutorial.`);
  return row.artifactHash;
}

/** The exact bytes the presented publication points at. */
function publishedArtifact(
  review: StoredReview,
  kind: ReviewArtifactKind,
): Promise<string | null> {
  return readReviewArtifactBytes(review.dir, kind, artifactHash(review, kind));
}
