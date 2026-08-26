import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findReview, listReviews } from "../review-home";
import type { createTutorialAgentSession } from "../tutorial-agent-session";
import { materializePublishRevision } from "./publish-stage";
import { createTutorialService } from "./tutorial-service";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

afterEach(() => vi.unstubAllEnvs());

describe("tutorial service", () => {
  it("materializes a hidden published Review with shipped bundles", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-tutorial-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const service = createTutorialService({
      packageRoot,
      deleteReview: async (review) => {
        await rm(review.dir, { recursive: true, force: true });
      },
      createAgentSession: vi.fn<typeof createTutorialAgentSession>(
        async ({ harness }) => ({
          harness,
          sessionId: "tutorial-source-session",
        }),
      ),
    });

    try {
      const review = await service.prepare("claude-code");
      const revision = review.review.presentedDocumentRevision;

      expect(review.dir).toBe(path.join(home, "reviews", review.review.uuid));
      expect(review.review).toMatchObject({
        visibility: "system",
        sourceSession: "claude-code:tutorial-source-session",
        agentSessions: {
          "claude-code:tutorial-source-session": {
            roles: ["author"],
          },
        },
        status: "awaiting-review",
        presentedDocumentRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
        presentedSoftwareMapRevision: revision,
      });
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
          path.join(build, ".bundle", "document", "review-document.js"),
          "utf8",
        ),
      ).resolves.toContain("createActiveReviewDocument");
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
});
