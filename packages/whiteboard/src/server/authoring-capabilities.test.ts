import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseWhiteboardDesktopVerbFrame } from "@dev.fast/whiteboard-protocol";
import { expect, it } from "vitest";

import { connectSessionApi } from "../session-api/agent-client.js";
import { openLocalSessionStore } from "../session-api/local-data.js";
import { WhiteboardTelemetry } from "../whiteboard-telemetry.js";
import { createGlobalWhiteboardServer } from "./desktop-server.js";
import { GlobalWhiteboardDesktopVerbRelay } from "./global-verb-relay.js";

it("discovers the live Desktop map preference without opening a review", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-capabilities-"));

  const env = {
    ...process.env,
    DEV_WHITEBOARD_HOME: home,
    DEV_WHITEBOARD_SERVER_DIR: "",
    DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED: "1",
  };

  const local = openLocalSessionStore(path.join(home, "review-api.db"));
  const relay = new GlobalWhiteboardDesktopVerbRelay();
  let softwareMapEnabled = false;
  let opened = false;
  relay.attach({
    signal: new AbortController().signal,
    write(frame) {
      const { id, request } = parseWhiteboardDesktopVerbFrame(
        JSON.parse(frame.slice("data: ".length).trim()),
      );

      if (request.name === "openApiWhiteboard") opened = true;
      relay.acceptResult({
        id,
        response: { ok: true, result: { softwareMapEnabled } },
      });
    },
    close() {},
  });

  const server = createGlobalWhiteboardServer({
    whiteboardStore: local.store,
    whiteboardData: local.data,
    appPid: process.pid,
    packageRoot: home,
    toolingRoot: home,
    port: 0,
    relay,
    discoveryPath: path.join(home, "review-desktop", "server.json"),
    telemetry: WhiteboardTelemetry.fromEnv(env),
  });

  try {
    await server.listen();
    // A previous headless process must not hijack the Desktop connection.
    await mkdir(path.join(home, "review-server"));
    await writeFile(
      path.join(home, "review-server", "server.json"),
      JSON.stringify({
        version: 1,
        instanceId: randomUUID(),
        url: server.discovery.url,
        serverPid: process.pid,
        token: "expired-headless-token",
      }),
    );
    const client = await connectSessionApi(env);
    expect(await client.read("/capabilities")).toMatchObject({
      desktopAvailable: true,
      softwareMapEnabled: false,
      scratchpadEnabled: false,
    });
    softwareMapEnabled = true;
    expect(await client.read("/capabilities")).toMatchObject({
      desktopAvailable: true,
      softwareMapEnabled: true,
    });
    expect(opened).toBe(false);
    await expect(
      connectSessionApi({ ...env, DEV_WHITEBOARD_SERVER_DIR: home }),
    ).rejects.toThrow(/whiteboard server start/);
    relay.close();
    expect(await client.read("/capabilities")).toMatchObject({
      desktopAvailable: false,
      softwareMapEnabled: false,
    });
    await expect(
      connectSessionApi({
        ...env,
        DEV_WHITEBOARD_SERVER_DIR: path.join(home, "missing"),
      }),
    ).rejects.toThrow(/whiteboard server start/);
  } finally {
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  }
});
