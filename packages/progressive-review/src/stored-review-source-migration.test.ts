import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { sealLegacyReviewCandidate } from "./fixtures/legacy-reviews/legacy-review-git";
import { createReviewDir, readStoredReview } from "./review-home";
import type { createReviewSourceAgentSession } from "./review-source-agent-session";
import { deleteReviewState } from "./review-state-db";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";
import { migrateStoredReview } from "./stored-review-migration";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(["document", "materialize"])(
  "does not fork before %s validation succeeds",
  async (failure) => {
    const { review, original } = await fixture(failure === "document");
    const createSourceSession = vi.fn<typeof createReviewSourceAgentSession>(
      async () => ({
        harness: "codex" as const,
        sessionId: "frozen",
      }),
    );
    const failedMaterialize =
      failure === "materialize"
        ? vi
            .spyOn(reviewVcs, "materialize")
            .mockRejectedValue(new Error("sealed revision unreadable"))
        : undefined;
    for (const attempt of [1, 2]) {
      await expect(
        migrateStoredReview({ reviewDir: review.dir, createSourceSession }),
        `failed scan ${attempt}`,
      ).rejects.toThrow(
        failure === "document"
          ? "broken document"
          : "sealed revision unreadable",
      );
    }
    expect(createSourceSession).not.toHaveBeenCalled();
    expect(await readFile(path.join(review.dir, "review.json"), "utf8")).toBe(
      original,
    );
    expect(existsSync(`${review.dir}.source-migration.json`)).toBe(false);
    failedMaterialize?.mockRestore();
    if (failure === "document") {
      await writeFile(
        path.join(review.dir, ".bundle/document/review-document.js"),
        legacyDocument,
      );
      const revision = await sealLegacyReviewCandidate(
        review.dir,
        "Repaired fixture",
      );
      await writeFile(
        path.join(review.dir, "review.json"),
        JSON.stringify({
          ...JSON.parse(original),
          presentedDocumentRevision: revision,
        }),
      );
      // The database is authoritative for the record; a repair that only
      // rewrites the mirror has to drop the imported row it supersedes.
      deleteReviewState(review.dir);
    }
    const migrated = await migrateStoredReview({
      reviewDir: review.dir,
      createSourceSession,
    });
    expect(migrated.record.sourceSession).toBe("codex:frozen");
    expect(createSourceSession).toHaveBeenCalledTimes(1);
  },
);

it("reuses a durable fork after record promotion fails", async () => {
  const { review, original } = await fixture();
  const displaced = `${review.dir}.displaced`;
  const createSourceSession = vi.fn<typeof createReviewSourceAgentSession>(
    async () => {
      await rename(review.dir, displaced);
      return {
        harness: "codex" as const,
        sessionId: "frozen",
      };
    },
  );
  try {
    await expect(
      migrateStoredReview({ reviewDir: review.dir, createSourceSession }),
    ).rejects.toThrow("Cannot activate a publication");
  } finally {
    await rename(displaced, review.dir);
  }
  expect(createSourceSession).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(review.dir, "review.json"), "utf8")).toBe(
    original,
  );
  expect(
    JSON.parse(await readFile(`${review.dir}.source-migration.json`, "utf8")),
  ).toMatchObject({ state: "ready", sourceSession: "codex:frozen" });
  const migrated = await migrateStoredReview({
    reviewDir: review.dir,
    createSourceSession,
  });
  expect(migrated.record.sourceSession).toBe("codex:frozen");
  expect(createSourceSession).toHaveBeenCalledTimes(1);
  expect(existsSync(`${review.dir}.source-migration.json`)).toBe(false);
});

it("serializes concurrent direct migration and loader before creating a fork", async () => {
  const { review } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const createSourceSession = vi.fn<typeof createReviewSourceAgentSession>(
    async () => {
      entered.resolve();
      await release.promise;
      return { harness: "codex" as const, sessionId: "frozen" };
    },
  );
  const first = migrateStoredReview({
    reviewDir: review.dir,
    createSourceSession,
  });
  await entered.promise;
  const second = migrateStoredReview({
    reviewDir: review.dir,
    createSourceSession,
  });
  const loaded = readStoredReview(review.dir);
  release.resolve();
  const results = await Promise.all([first, second, loaded]);
  expect(createSourceSession).toHaveBeenCalledTimes(1);
  expect(results[0].record.sourceSession).toBe("codex:frozen");
  expect(results[1].record.sourceSession).toBe("codex:frozen");
  expect(results[2]).toMatchObject({
    review: { sourceSession: "codex:frozen" },
  });
});

it.each(["started", "different pins"])(
  "fails closed for a pending binding with %s",
  async (state) => {
    const { review } = await fixture();
    const displaced = `${review.dir}.displaced`;
    const createSourceSession = vi.fn<typeof createReviewSourceAgentSession>(
      async () => {
        await rename(review.dir, displaced);
        return {
          harness: "codex" as const,
          sessionId: "frozen",
        };
      },
    );
    try {
      await expect(
        migrateStoredReview({ reviewDir: review.dir, createSourceSession }),
      ).rejects.toThrow("Cannot activate a publication");
    } finally {
      await rename(displaced, review.dir);
    }
    const statePath = `${review.dir}.source-migration.json`;
    const pending = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(
      statePath,
      JSON.stringify(
        state === "started"
          ? { version: 1, key: pending.key, state: "started" }
          : { ...pending, key: "different" },
      ),
    );
    await expect(
      migrateStoredReview({ reviewDir: review.dir, createSourceSession }),
    ).rejects.toThrow(
      state === "started" ? "was interrupted" : "different Review pins",
    );
    expect(createSourceSession).toHaveBeenCalledTimes(1);
  },
);

it("preserves disabled-source behavior for a native provider failure", async () => {
  const { review } = await fixture();
  const createSourceSession = vi.fn<typeof createReviewSourceAgentSession>(
    async () => {
      throw new Error("provider unavailable");
    },
  );
  const log = vi.fn<(message: string) => void>();
  const migrated = await migrateStoredReview({
    reviewDir: review.dir,
    createSourceSession,
    log,
  });
  expect(migrated.record.sourceSession).toBe("disabled:review");
  expect(log.mock.calls.flat().join(" ")).toContain("provider unavailable");
  await migrateStoredReview({ reviewDir: review.dir, createSourceSession });
  expect(createSourceSession).toHaveBeenCalledTimes(1);
});

it("does not turn a binding persistence failure into disabled success or another fork", async () => {
  const { review, original } = await fixture();
  const statePath = `${review.dir}.source-migration.json`;
  const createSourceSession = vi.fn<typeof createReviewSourceAgentSession>(
    async () => {
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        state: "started",
      });
      await rm(statePath);
      await mkdir(statePath);
      return { harness: "codex", sessionId: "frozen" };
    },
  );
  await expect(
    migrateStoredReview({ reviewDir: review.dir, createSourceSession }),
  ).rejects.toThrow(/EISDIR|EEXIST/);
  await expect(
    migrateStoredReview({ reviewDir: review.dir, createSourceSession }),
  ).rejects.toThrow("Cannot read source migration binding");
  expect(createSourceSession).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(review.dir, "review.json"), "utf8")).toBe(
    original,
  );
});

async function fixture(broken = false) {
  const home = await mkdtemp(path.join(tmpdir(), "review-source-migration-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const source = path.join(home, "source");
  await mkdir(source);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(source, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]);
  const review = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  const bundle = path.join(review.dir, ".bundle/document");
  await mkdir(bundle, { recursive: true });
  await writeFile(
    path.join(bundle, "manifest.json"),
    JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
  );
  await writeFile(
    path.join(bundle, "review-document.js"),
    broken
      ? 'import { jsx } from "review-doc-runtime"; throw new Error("broken document");'
      : legacyDocument,
  );
  const revision = await sealLegacyReviewCandidate(
    review.dir,
    "Legacy document",
  );
  const original = JSON.stringify({
    ...review.review,
    schemaVersion: 3,
    agentSession: "codex:original",
    sourceSession: undefined,
    presentedDocumentRevision: revision,
  });
  await writeFile(path.join(review.dir, "review.json"), original);
  deleteReviewState(review.dir);
  return { review, original };
}

const legacyDocument =
  'import { createActiveReviewDocument, jsx } from "review-doc-runtime"; export default createActiveReviewDocument({ title: "Legacy", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: () => jsx("p", { children: "Legacy" }), isDefault: true });';
