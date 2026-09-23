import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { isObjectValue } from "@dev.fast/json";
import { withFileLock, writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { Hono } from "hono";

import { legacyWhiteboardApi } from "../legacy-rename.js";
import {
  type WhiteboardServerDiscovery,
  whiteboardServerDiscoveryPath,
} from "../server-discovery.js";
import { createSessionApi } from "../session-api/http.js";
import { openWhiteboardProfile } from "../session-api/profile.js";
import { mountSharingPublisher } from "../sharing/host.js";
import { readScratchpadEnabled } from "../whiteboard-preferences.js";
import {
  type WhiteboardHonoEnv,
  createNodeRequestListener,
  isAuthorizedRequest,
} from "./hono-http.js";

interface HeadlessServerInput {
  stateDir: string;
  port?: number;
  softwareMapEnabled?: boolean;
  signal: AbortSignal;
  onReady(discovery: WhiteboardServerDiscovery): void;
}

/** One foreground headless endpoint per profile; Desktop shares its database. */
export async function runHeadlessServer(input: HeadlessServerInput) {
  await mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(input.stateDir);

  const outcome = await withFileLock(
    path.join(stateDir, "headless-server.lock"),
    {
      timeoutMs: 0,
      retryMs: 20,
      // A paused live owner must never lose exclusive access to its store.
      staleMs: Infinity,
      unownedGraceMs: 1_000,
    },
    () => serve({ ...input, stateDir }),
  );

  if (!outcome.acquired)
    throw new Error(
      `A Review server already owns ${stateDir}. Stop it first, or choose another --state-dir.`,
    );
}

async function serve(input: HeadlessServerInput) {
  if (input.signal.aborted) return;

  const local = await openWhiteboardProfile(input.stateDir, {
    manageWorkspaces: false,
  });

  const discovery: WhiteboardServerDiscovery = {
    version: 1,
    instanceId: randomUUID(),
    url: "http://127.0.0.1:0",
    serverPid: process.pid,
    token: randomBytes(32).toString("base64url"),
  };

  const app = new Hono<WhiteboardHonoEnv>();
  app.use("*", async (context, next) => {
    if (!isAuthorizedRequest(context.req.raw, discovery.token))
      return context.json({ error: "Unauthorized" }, 401);
    await next();
  });
  app.get("/health", (context) =>
    context.json({ ok: true, instanceId: discovery.instanceId }),
  );

  const scratchpadEnabled = await readScratchpadEnabled();
  app.route("/reviews-api", legacyWhiteboardApi());

  const api = createSessionApi(
    local.store,
    local.data,
    undefined,
    undefined,
    () => ({
      desktopAvailable: false,
      softwareMapEnabled: input.softwareMapEnabled ?? false,
    }),
    () => scratchpadEnabled,
  );

  mountSharingPublisher(api, local.store, local.data);
  app.route("/sessions-api", api);

  const server = createServer(createNodeRequestListener(app));
  let published = false;

  try {
    const listening = once(server, "listening");
    server.listen(input.port ?? 0, "127.0.0.1");
    await listening;
    const address = server.address();

    if (!isObjectValue(address))
      throw new Error("Review server did not bind a TCP port.");
    discovery.url = `http://127.0.0.1:${address.port}`;
    await writePrivateJsonAtomic(
      whiteboardServerDiscoveryPath(input.stateDir),
      discovery,
    );
    published = true;
    input.onReady(discovery);

    await new Promise<void>((resolve) => {
      if (input.signal.aborted) resolve();
      else
        input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    // Watch streams may live forever. Drain ordinary requests, then bound shutdown.
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();

    try {
      if (published)
        await rm(whiteboardServerDiscoveryPath(input.stateDir), {
          force: true,
        });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearTimeout(forceClose);

      try {
        await local.data.close();
      } finally {
        await local.store.close();
      }
    }
  }
}
