import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  reviewDocumentBundleData,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { findReview, listReviews } from "../review-home";
import { materializePublishRevision } from "./publish-stage";
import { createTutorialService } from "./tutorial-service";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const execFilePromise = promisify(execFile);

afterEach(() => vi.unstubAllEnvs());

describe("tutorial service", () => {
  it.each(["missing", "invalid-json", "invalid-schema"])(
    "rejects a saved tutorial with %s document data",
    async (kind) => {
      const home = await mkdtemp(
        path.join(os.tmpdir(), "review-tutorial-invalid-"),
      );
      vi.stubEnv("DEV_REVIEW_HOME", home);
      const service = createTutorialService({
        packageRoot,
        deleteReview: async (review) => {
          await rm(review.dir, { recursive: true, force: true });
        },
      });
      try {
        const saved = await service.prepare("claude-code");
        expect((await service.status()).reviewUuid).toBe(saved.review.uuid);
        const documentPath = path.join(
          saved.dir,
          ".bundle/document/review-document.json",
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

  it("refreshes the saved document after a tutorial edit without changing sample commits", async () => {
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
    const service = createTutorialService({
      packageRoot: assets,
      deleteReview: async (review) => {
        await rm(review.dir, { recursive: true, force: true });
      },
    });
    try {
      const before = await service.prepare("claude-code");
      const documentPath = path.join(
        ".bundle",
        "document",
        "review-document.json",
      );
      const shipped = await readReviewDocumentBundle(
        path.join(assets, "tutorial"),
        "/",
      );
      if (!shipped) throw new Error("Missing shipped tutorial JSON");
      const document = reviewDocumentBundleData(shipped);
      await writeReviewDocumentBundle(
        path.join(assets, "tutorial"),
        bundleReviewDocument({
          ...document,
          body: [
            ...document.body,
            {
              type: "element",
              tag: "p",
              props: {},
              children: [{ type: "text", value: "Updated tutorial copy" }],
            },
          ],
        }),
      );
      expect((await service.status()).reviewUuid).toBeNull();
      const after = await service.prepare("claude-code");
      expect(after.review.uuid).not.toBe(before.review.uuid);
      expect(after.review.sourceCommit).toBe(before.review.sourceCommit);
      expect(await readFile(path.join(after.dir, documentPath), "utf8")).toBe(
        await readFile(path.join(assets, "tutorial", documentPath), "utf8"),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("materializes a hidden published Review with shipped bundles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = createTutorialService({
      packageRoot,
      deleteReview: async (review) => {
        await rm(review.dir, { recursive: true, force: true });
      },
    });

    try {
      const review = await service.prepare("claude-code");
      const revision = review.review.presentedDocumentRevision;

      expect(review.dir).toBe(path.join(home, "reviews", review.review.uuid));
      expect(review.review).toMatchObject({
        visibility: "system",
        sourceSession: "fresh:claude-code",
        status: "awaiting-review",
        presentedDocumentRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
        presentedSoftwareMapRevision: revision,
      });
      expect(review.review.agentSessions).toBeUndefined();
      await expect(listReviews()).resolves.toMatchObject({ reviews: [] });
      await expect(listReviews({ includeSystem: true })).resolves.toMatchObject(
        { reviews: [{ review: { uuid: review.review.uuid } }] },
      );
      const build = await materializePublishRevision({
        review,
        revision: revision!,
      });
      await expect(
        readFile(
          path.join(build, ".bundle", "document", "review-document.json"),
          "utf8",
        ),
      ).resolves.toContain('"format":"review-document/1"');
      await expect(
        readFile(path.join(review.dir, "authoring-conversation.json"), "utf8"),
      ).resolves.toContain('"title": "How this Review was made"');
      await expect(service.status()).resolves.toEqual({
        version: 1,
        reviewUuid: review.review.uuid,
      });

      await service.cleanup();
      await expect(findReview(review.review.uuid)).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds a fresh marker when the installed harness changes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = createTutorialService({
      packageRoot,
      deleteReview: async (review) => {
        await rm(review.dir, { recursive: true, force: true });
      },
    });

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

  it("fails closed when repository history is invalid or Git fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = createTutorialService({
      packageRoot,
      deleteReview: async (review) => {
        await rm(review.dir, { recursive: true, force: true });
      },
    });
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
