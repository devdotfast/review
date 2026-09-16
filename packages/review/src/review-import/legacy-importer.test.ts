import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import type { StoredReview } from "../review-home";
import {
  materializeFromRevisionDirs,
  scratchGitRepo,
  syntheticLegacyReview,
} from "./import-test-utils";
import { createLegacyImporter } from "./legacy-importer";

describe("createLegacyImporter", () => {
  it("sweeps once, reports current afterwards, and shares in-flight imports", async () => {
    const repo = await scratchGitRepo();

    const first = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    const second = await syntheticLegacyReview(
      "schema4-opencode-agentserver",
      repo,
    );

    const { store, data } = openLocalReviewStore(
      path.join(first.home, "review-api.db"),
    );

    const importVersion = vi.spyOn(store, "importVersion");
    const onImported = vi.fn<() => Promise<void>>(async () => {});

    const importer = createLegacyImporter({
      store,
      data,
      materialize: materializeFromRevisionDirs,
      onImported,
      log: () => {},
    });

    try {
      const sweep = importer.sweep([first.stored, second.stored]);
      const joined = await importer.ensure(first.stored);
      const outcomes = await sweep;

      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        "imported",
        "imported",
      ]);
      expect(joined.kind).toBe("imported");
      expect(importVersion).toHaveBeenCalledTimes(2);
      expect(onImported).toHaveBeenCalledTimes(2);

      const again = await importer.sweep([first.stored, second.stored]);
      expect(again.map((outcome) => outcome.kind)).toEqual([
        "current",
        "current",
      ]);
      expect(onImported).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it("turns a failing import into a skipped outcome without stopping the sweep", async () => {
    const repo = await scratchGitRepo();

    const broken = await syntheticLegacyReview(
      "schema4-bug-report-dialog",
      repo,
    );

    const fine = await syntheticLegacyReview(
      "schema4-opencode-agentserver",
      repo,
    );

    const { store, data } = openLocalReviewStore(
      path.join(broken.home, "review-api.db"),
    );

    const log = vi.fn<(message: string) => void>();

    const importer = createLegacyImporter({
      store,
      data,
      materialize: async (review: StoredReview, revision: string) => {
        if (review.review.uuid === broken.record.uuid)
          throw new Error("disk on fire");

        return materializeFromRevisionDirs(review, revision);
      },
      onImported: async () => {},
      log,
      concurrency: 1,
    });

    try {
      const outcomes = await importer.sweep([broken.stored, fine.stored]);

      expect(outcomes).toEqual([
        {
          kind: "skipped",
          reviewId: broken.record.uuid,
          reason: "disk on fire",
        },
        expect.objectContaining({
          kind: "imported",
          reviewId: fine.record.uuid,
        }),
      ]);
      expect(log).toHaveBeenCalledWith(
        `[Review import] ${broken.record.uuid}: skipped (disk on fire)`,
      );
      expect(store.has(broken.record.uuid)).toBe(false);
    } finally {
      await store.close();
    }
  });
});
