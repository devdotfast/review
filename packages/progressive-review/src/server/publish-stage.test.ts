import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createReviewDir,
  materializeReviewRevision,
  sealReviewCandidate,
} from "../review-home";
import { materializePublishRevision } from "./publish-stage";

describe("publish revision stage", () => {
  it.each(["empty", "partial", "wrong-revision"] as const)(
    "rebuilds a %s cache and shares a complete result across concurrent opens",
    async (kind) => {
      await withPublishedFixture(async (review, revision) => {
        const destination = path.join(review.dir, ".build", revision);
        await mkdir(destination, { recursive: true });
        if (kind !== "empty")
          await writeFile(path.join(destination, "data.ts"), "partial");
        if (kind === "wrong-revision")
          await writeFile(
            path.join(destination, ".review-materialized.json"),
            JSON.stringify({
              format: "review-materialization/1",
              revision: "f".repeat(40),
            }),
          );
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            materializePublishRevision({ review, revision }),
          ),
        );
        expect(new Set(results)).toEqual(new Set([destination]));
        expect(await readFile(path.join(destination, "data.ts"), "utf8")).toBe(
          "complete",
        );
        expect(
          JSON.parse(
            await readFile(path.join(destination, "review.json"), "utf8"),
          ).uuid,
        ).toBe(review.review.uuid);
        expect(await readdir(path.dirname(destination))).toEqual([revision]);
      });
    },
  );

  it("cleans a failed partial materialization and retries successfully", async () => {
    await withPublishedFixture(async (review, revision) => {
      await expect(
        materializePublishRevision(
          { review, revision },
          {
            materialize: async (dir, ref, destination) => {
              await mkdir(destination, { recursive: true });
              await writeFile(path.join(destination, "data.ts"), "partial");
              throw new Error("read failed");
            },
          },
        ),
      ).rejects.toThrow("read failed");
      expect(await readdir(path.join(review.dir, ".build"))).toEqual([]);
      const destination = await materializePublishRevision({
        review,
        revision,
      });
      expect(await readFile(path.join(destination, "data.ts"), "utf8")).toBe(
        "complete",
      );
    });
  });

  it("rejects invalid sealed metadata without installing a cache", async () => {
    await withPublishedFixture(async (review, revision) => {
      await expect(
        materializePublishRevision(
          { review, revision },
          {
            materialize: async (dir, ref, destination) => {
              await materializeReviewRevision(dir, ref, destination);
              await writeFile(path.join(destination, "review.json"), "{}");
            },
          },
        ),
      ).rejects.toThrow(/schemaVersion/);
      expect(await readdir(path.join(review.dir, ".build"))).toEqual([]);
    });
  });

  it("materializes a review Git revision into its build staging directory", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-publish-home-"));
    const source = await mkdtemp(
      path.join(os.tmpdir(), "review-publish-source-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    try {
      const review = await createReviewDir({
        worktreePath: source,
        baseRef: "HEAD",
        baseCommit: "base-commit",
      });
      await writeFile(
        path.join(review.dir, "data.ts"),
        "export const data = 1;\n",
      );
      const revision = await sealReviewCandidate(review.dir, "test revision");

      const destination = await materializePublishRevision({
        review,
        revision,
      });

      await expect(
        readFile(path.join(destination, "data.ts"), "utf8"),
      ).resolves.toBe("export const data = 1;\n");
      await writeFile(path.join(destination, "data.ts"), "live\n");
      await expect(
        materializePublishRevision({ review, revision }),
      ).resolves.toBe(destination);
      await expect(
        readFile(path.join(destination, "data.ts"), "utf8"),
      ).resolves.toBe("live\n");
      await expect(
        materializePublishRevision({ review, revision: ".." }),
      ).rejects.toThrow("Review revision is invalid");
      await expect(
        materializePublishRevision({ review, revision: "." }),
      ).rejects.toThrow("Review revision is invalid");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });
});

async function withPublishedFixture(
  run: (
    review: Awaited<ReturnType<typeof createReviewDir>>,
    revision: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-materialize-"));
  try {
    const review = await createReviewDir({
      reviewsHomePath: path.join(root, "reviews"),
      worktreePath: root,
      baseRef: "HEAD",
      baseCommit: "a".repeat(40),
    });
    await writeFile(path.join(review.dir, "data.ts"), "complete");
    const revision = await sealReviewCandidate(review.dir, "Complete");
    await run(review, revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
