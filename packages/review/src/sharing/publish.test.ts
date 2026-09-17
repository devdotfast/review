import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeStoreAuth } from "@dev.fast/trace-core";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";

import { createShareFixture } from "../../test/fixtures/share/create.js";
import { ReviewInputError } from "../review-api/document.js";
import { ShareClient } from "./client.js";
import { mountSharingHost } from "./host.js";
import { SharedReviewStore } from "./import.js";

it("rejects unavailable GitHub commits before any share upload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharing-publish-"));
  const fixture = await createShareFixture(root);
  const create = vi.spyOn(ShareClient.prototype, "create");
  vi.stubEnv("DEV_REVIEW_HOME", root);

  try {
    await writeStoreAuth({
      origin: "https://app.dev.fast",
      token: "fixture",
      login: "fixture",
      savedAt: new Date().toISOString(),
    });
    const api = new Hono();
    api.onError((error, context) =>
      context.json(
        { error: error.message },
        error instanceof ReviewInputError ? error.status : 500,
      ),
    );
    mountSharingHost(
      api,
      fixture.store,
      fixture.data,
      new SharedReviewStore(path.join(root, "shared")),
      {
        verifyRepository: async () => {
          throw new ReviewInputError(
            "Push the reviewed commits to GitHub before sharing.",
            409,
          );
        },
      },
    );

    const response = await api.request("/sharing/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId: fixture.reviewId }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Push the reviewed commits to GitHub before sharing.",
    });
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
    vi.unstubAllEnvs();
    await fixture.data.close();
    await fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
