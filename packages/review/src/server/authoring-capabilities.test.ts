import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseReviewDesktopVerbFrame } from "@dev.fast/review-protocol";
import { expect, it } from "vitest";

import { connectReviewApi } from "../review-api/agent-client.js";
import { openLocalReviewStore } from "../review-api/local-data.js";
import { ReviewTelemetry } from "../review-telemetry.js";
import { createGlobalReviewServer } from "./desktop-server.js";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay.js";

it("discovers the live Desktop map preference without opening a review", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-capabilities-"));

  const env = {
    ...process.env,
    DEV_REVIEW_HOME: home,
    DEV_REVIEW_SERVER_DIR: "",
    DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
  };

  const local = openLocalReviewStore(path.join(home, "review-api.db"));
  const relay = new GlobalReviewDesktopVerbRelay();
  let softwareMapEnabled = false;
  let opened = false;
  relay.attach({
    signal: new AbortController().signal,
    write(frame) {
      const { id, request } = parseReviewDesktopVerbFrame(
        JSON.parse(frame.slice("data: ".length).trim()),
      );

      if (request.name === "openApiReview") opened = true;
      relay.acceptResult({
        id,
        response: { ok: true, result: { softwareMapEnabled } },
      });
    },
    close() {},
  });

  const server = createGlobalReviewServer({
    reviewStore: local.store,
    reviewData: local.data,
    appPid: process.pid,
    packageRoot: home,
    toolingRoot: home,
    port: 0,
    relay,
    discoveryPath: path.join(home, "review-desktop", "server.json"),
    telemetry: ReviewTelemetry.fromEnv(env),
  });

  try {
    await server.listen();
    const client = await connectReviewApi(env);
    expect(await client.read("/capabilities")).toMatchObject({
      desktopAvailable: true,
      softwareMapEnabled: false,
    });
    softwareMapEnabled = true;
    expect(await client.read("/capabilities")).toMatchObject({
      desktopAvailable: true,
      softwareMapEnabled: true,
    });
    expect(opened).toBe(false);
    relay.close();
    expect(await client.read("/capabilities")).toMatchObject({
      desktopAvailable: false,
      softwareMapEnabled: false,
    });
    await expect(
      connectReviewApi({
        ...env,
        DEV_REVIEW_SERVER_DIR: path.join(home, "missing"),
      }),
    ).rejects.toThrow(/review server start/);
  } finally {
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  }
});
