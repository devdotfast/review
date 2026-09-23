import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SCRATCHPAD_SESSION_ID } from "@dev.fast/whiteboard-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { openLocalSessionStore } from "../session-api/local-data";
import { readWhiteboardPreferences } from "../whiteboard-preferences";
import { createGlobalWhiteboardServer } from "./desktop-server";

const token = "scratchpad-test-token";

afterEach(() => vi.unstubAllEnvs());

/**
 * The scratchpad preference controls whether the server makes and lists the
 * pad; existing content survives while the pad is hidden.
 */
it("makes and lists the scratchpad only while its preference is on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-scratchpad-pref-"));
  const devHome = path.join(root, "dev-review");
  const packageRoot = path.join(root, "package");
  vi.stubEnv("DEV_WHITEBOARD_HOME", devHome);
  await mkdir(devHome, { recursive: true });

  const local = openLocalSessionStore(path.join(devHome, "review-api.db"));

  const serve = () =>
    createGlobalWhiteboardServer({
      whiteboardStore: local.store,
      whiteboardData: local.data,
      appPid: process.pid,
      packageRoot,
      toolingRoot: packageRoot,
      port: 0,
      token,
      discoveryPath: path.join(devHome, "desktop.json"),
    });

  const headers = {
    "x-whiteboard-token": token,
    "content-type": "application/json",
  };

  const get = async (url: string, route: string) =>
    fetch(`${url}${route}`, { headers });

  const setEnabled = async (url: string, enabled: boolean) => {
    const response = await fetch(`${url}/preferences/scratchpad`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled }),
    });

    expect(response.status).toBe(200);

    return response.json();
  };

  let server = serve();

  try {
    await server.listen();

    // Off by default: nothing listed, and the pad's id is refused.
    expect(await (await get(server.url, "/sessions-api")).json()).toEqual([]);
    expect(
      await (await get(server.url, "/sessions-api/capabilities")).json(),
    ).toMatchObject({ scratchpadEnabled: false });

    const refused = await get(
      server.url,
      `/sessions-api/${SCRATCHPAD_SESSION_ID}`,
    );

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringMatching(/scratchpad is off/i),
    });

    const created = await fetch(`${server.url}/sessions-api/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        commandId: "6d6e0a4e-0000-4000-8000-000000000001",
        operation: { type: "create", title: "Scratchpad", kind: "scratchpad" },
      }),
    });

    expect(created.status).toBe(409);
    expect(local.store.has(SCRATCHPAD_SESSION_ID)).toBe(false);

    // On: the pad exists and is listed.
    expect(await setEnabled(server.url, true)).toEqual({ enabled: true });
    expect((await readWhiteboardPreferences(devHome)).scratchpadEnabled).toBe(
      true,
    );
    expect(await (await get(server.url, "/sessions-api")).json()).toMatchObject(
      [{ sessionId: SCRATCHPAD_SESSION_ID, kind: "scratchpad" }],
    );
    expect(
      await (await get(server.url, "/sessions-api/capabilities")).json(),
    ).toMatchObject({ scratchpadEnabled: true });
    expect(
      (await get(server.url, `/sessions-api/${SCRATCHPAD_SESSION_ID}`)).status,
    ).toBe(200);
    // Off again: hidden and refused, but not deleted.
    expect(await setEnabled(server.url, false)).toEqual({ enabled: false });
    expect(await (await get(server.url, "/sessions-api")).json()).toEqual([]);
    expect(
      (await get(server.url, `/sessions-api/${SCRATCHPAD_SESSION_ID}`)).status,
    ).toBe(409);
    expect(local.store.has(SCRATCHPAD_SESSION_ID)).toBe(true);

    // A new server starts from the saved preference.
    await setEnabled(server.url, true);
    await server.close();
    server = serve();
    await server.listen();
    expect(await (await get(server.url, "/sessions-api")).json()).toMatchObject(
      [{ sessionId: SCRATCHPAD_SESSION_ID, kind: "scratchpad" }],
    );
  } finally {
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
