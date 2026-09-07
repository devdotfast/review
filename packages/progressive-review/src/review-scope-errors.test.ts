import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProgressiveReviewCli } from "./cli-runner";
import {
  ReviewHomeScanError,
  createReviewDir,
  findReview,
  listReviews,
  sealReviewCandidate,
} from "./review-home";
import { startLifecycleTestServer } from "./review-lifecycle-test-utils";
import { runReviewScaffold } from "./review-scaffold";
import { deleteReviewState } from "./review-state-db";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import { resolvePublishReview } from "./server/publish-preparation";
import { resolveReviewInfo } from "./server/review-info";
import { runReviewThreadsList } from "./threads-cli";

const execFilePromise = promisify(execFile);
const roots: string[] = [];
let server: Awaited<ReturnType<typeof startLifecycleTestServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  closeAllReviewThreadStores();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "review-scope-errors-")),
  );
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
  async function create(label: string) {
    const root = path.join(home, label);
    await mkdir(root);
    await execFilePromise("git", ["init", "-b", "main"], { cwd: root });
    await execFilePromise("git", ["config", "user.name", "Fixture"], {
      cwd: root,
    });
    await execFilePromise(
      "git",
      ["config", "user.email", "fixture@example.com"],
      { cwd: root },
    );
    await writeFile(path.join(root, "README.md"), `${label}\n`);
    await execFilePromise("git", ["add", "."], { cwd: root });
    await execFilePromise("git", ["commit", "-m", "Initial"], { cwd: root });
    const commit = (
      await execFilePromise("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const stored = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: commit,
      sourceCommit: commit,
      sourceIdentity: { kind: "git-branch", name: "main" },
      sourceSession: "disabled:review",
    });
    return { root, stored };
  }
  return {
    home,
    healthy: await create("healthy"),
    other: await create("other"),
  };
}

describe("scoped review diagnostics", () => {
  it("does not migrate an unrelated legacy review during a scoped scan", async () => {
    const { healthy, other } = await fixture();
    const reviewPath = path.join(other.stored.dir, "review.json");
    const legacy = JSON.stringify({ ...other.stored.review, schemaVersion: 4 });
    await writeFile(reviewPath, legacy);
    expect(
      (await listReviews({ worktreePath: healthy.root })).reviews.map(
        (entry) => entry.review.uuid,
      ),
    ).toEqual([healthy.stored.review.uuid]);
    expect(await readFile(reviewPath, "utf8")).toBe(legacy);
  });

  it.each(["malformed", "unsupported", "failed-conversion"] as const)(
    "isolates unrelated %s records while retaining global diagnostics",
    async (kind) => {
      const { home, healthy, other } = await fixture();
      const badPath = path.join(other.stored.dir, "review.json");
      let badRecord = { ...other.stored.review };
      if (kind === "failed-conversion") {
        const bundle = path.join(other.stored.dir, ".bundle", "document");
        await mkdir(bundle, { recursive: true });
        await writeFile(
          path.join(bundle, "manifest.json"),
          JSON.stringify({
            version: 1,
            routePath: "/",
            sourcePath: "review.mdx",
          }),
        );
        await writeFile(
          path.join(bundle, "review-document.js"),
          'throw new Error("broken sealed fixture");',
        );
        badRecord = {
          ...badRecord,
          presentedDocumentRevision: await sealReviewCandidate(
            other.stored.dir,
            "Broken fixture",
          ),
        };
      }
      const bytes = JSON.stringify({
        ...badRecord,
        schemaVersion:
          kind === "unsupported" ? 6 : kind === "failed-conversion" ? 4 : 5,
        baseCommit: kind === "malformed" ? 42 : badRecord.baseCommit,
      });
      await writeFile(badPath, bytes);
      deleteReviewState(other.stored.dir);
      await expect(
        resolvePublishReview(healthy.root, undefined),
      ).resolves.toMatchObject({ dir: healthy.stored.dir });
      const unknownUuid = "11111111-1111-4111-8111-111111111111";
      const unknownDir = path.join(home, "reviews", unknownUuid);
      await mkdir(unknownDir);
      await writeFile(path.join(unknownDir, "review.json"), "{broken");

      const scoped = await listReviews({ worktreePath: healthy.root });
      expect(scoped.errors).toEqual([]);
      expect(scoped.reviews.map((entry) => entry.review.uuid)).toEqual([
        healthy.stored.review.uuid,
      ]);
      const repository = await listReviews({
        repoKey: healthy.stored.review.repoKey,
      });
      expect(repository.errors).toEqual([]);
      expect(repository.reviews.map((entry) => entry.review.uuid)).toEqual([
        healthy.stored.review.uuid,
      ]);
      await expect(
        resolveReviewInfo({ cwd: healthy.root }),
      ).resolves.toMatchObject({
        reviews: [{ uuid: healthy.stored.review.uuid }],
      });
      await expect(
        resolvePublishReview(healthy.root, undefined),
      ).rejects.toThrow(unknownDir);
      await expect(
        resolvePublishReview(healthy.root, healthy.stored.review.uuid),
      ).resolves.toMatchObject({ dir: healthy.stored.dir });
      await expect(
        resolvePublishReview(other.root, healthy.stored.review.uuid),
      ).rejects.toThrow("Active review not found");
      server = await startLifecycleTestServer();
      await expect(
        runReviewThreadsList({ cwd: healthy.root, stdout: new PassThrough() }),
      ).resolves.toBe(0);

      const stdin = new PassThrough();
      stdin.end(JSON.stringify({ cwd: healthy.stored.dir }));
      const checkpoint = vi.fn<typeof sealReviewCandidate>(
        async () => "checkpoint",
      );
      await expect(
        runProgressiveReviewCli({
          argv: ["stop-hook"],
          stdin,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          runtime: { listReviews, sealReviewCandidate: checkpoint },
        }),
      ).resolves.toBe(0);
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith(
        healthy.stored.dir,
        "Review turn checkpoint",
      );

      const brokenStdin = new PassThrough();
      brokenStdin.end(JSON.stringify({ cwd: other.stored.dir }));
      const stderr = new PassThrough();
      await expect(
        runProgressiveReviewCli({
          argv: ["stop-hook"],
          stdin: brokenStdin,
          stdout: new PassThrough(),
          stderr,
          runtime: { listReviews, sealReviewCandidate: checkpoint },
        }),
      ).resolves.toBe(1);
      expect(stderr.read()?.toString()).toContain(
        "Could not checkpoint reviews",
      );
      expect(checkpoint).toHaveBeenCalledTimes(1);

      const global = await listReviews();
      expect(global.errors.map((error) => error.reviewUuid).sort()).toEqual(
        [other.stored.review.uuid, unknownUuid].sort(),
      );
      const related = await listReviews({ worktreePath: other.root });
      expect(related.errors.map((error) => error.reviewUuid)).toEqual([
        other.stored.review.uuid,
      ]);
      await expect(findReview(other.stored.review.uuid)).rejects.toBeInstanceOf(
        ReviewHomeScanError,
      );
      await expect(
        resolvePublishReview(other.root, other.stored.review.uuid),
      ).rejects.toBeInstanceOf(ReviewHomeScanError);
      await expect(
        runReviewThreadsList({
          cwd: other.root,
          reviewUuid: other.stored.review.uuid,
          stdout: new PassThrough(),
        }),
      ).rejects.toThrow("Could not read reviews");
      await expect(findReview(unknownUuid)).rejects.toBeInstanceOf(
        ReviewHomeScanError,
      );
      expect(await readFile(badPath, "utf8")).toBe(bytes);
      expect(await readFile(path.join(unknownDir, "review.json"), "utf8")).toBe(
        "{broken",
      );
    },
  );

  it("does not create an ambiguous binding when unknown metadata exists", async () => {
    const { home, healthy } = await fixture();
    const unknownDir = path.join(
      home,
      "reviews",
      "11111111-1111-4111-8111-111111111111",
    );
    await mkdir(unknownDir);
    await writeFile(path.join(unknownDir, "review.json"), "{broken");
    const before = await readdir(path.join(home, "reviews"));
    await expect(
      runReviewScaffold({ cwd: healthy.root, update: true }),
    ).rejects.toThrow("Could not read reviews");
    expect(await readdir(path.join(home, "reviews"))).toEqual(before);
    expect(await readFile(path.join(unknownDir, "review.json"), "utf8")).toBe(
      "{broken",
    );
  });
});
