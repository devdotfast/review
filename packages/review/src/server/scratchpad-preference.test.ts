import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SCRATCHPAD_SESSION_ID } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { openLocalSessionStore } from "../review-api/local-data";
import { readReviewPreferences } from "../review-preferences";
import { createGlobalReviewServer } from "./desktop-server";

const token = "scratchpad-test-token";

afterEach(() => vi.unstubAllEnvs());

/**
 * The scratchpad preference is off until Settings turns it on. Off, the
 * server neither makes nor lists the pad, refuses its id, and keeps its
 * skill out of every agent's skills directory; on, all of that reverses,
 * and a pad drawn on earlier keeps its contents across the flip.
 */
it("makes, lists and installs the scratchpad only while its preference is on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-scratchpad-pref-"));
  const home = path.join(root, "home");
  const devHome = path.join(root, "dev-review");
  const packageRoot = path.join(root, "package");
  vi.stubEnv("DEV_WHITEBOARD_HOME", devHome);
  // syncScratchpadSkills resolves agents under the user's home.
  vi.stubEnv("HOME", home);

  await mkdir(devHome, { recursive: true });
  // Claude Code counts as set up once a Review skill is present for it.
  await mkdir(path.join(home, ".claude", "skills", "dev-review"), {
    recursive: true,
  });
  await mkdir(path.join(packageRoot, "skills", "scratchpad"), {
    recursive: true,
  });
  await writeFile(
    path.join(packageRoot, "skills", "scratchpad", "SKILL.md"),
    "---\nname: scratchpad\ndescription: scratchpad\n---\n\n# scratchpad\n",
  );
  const installedSkill = path.join(home, ".claude", "skills", "scratchpad");

  const local = openLocalSessionStore(path.join(devHome, "review-api.db"));

  const serve = () =>
    createGlobalReviewServer({
      reviewStore: local.store,
      reviewData: local.data,
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

    // On: the pad exists, is listed, and the skill reaches set-up agents.
    expect(await setEnabled(server.url, true)).toEqual({ enabled: true });
    expect((await readReviewPreferences(devHome)).scratchpadEnabled).toBe(true);
    expect(await (await get(server.url, "/sessions-api")).json()).toMatchObject(
      [{ sessionId: SCRATCHPAD_SESSION_ID, kind: "scratchpad" }],
    );
    expect(
      await (await get(server.url, "/sessions-api/capabilities")).json(),
    ).toMatchObject({ scratchpadEnabled: true });
    expect(
      (await get(server.url, `/sessions-api/${SCRATCHPAD_SESSION_ID}`)).status,
    ).toBe(200);
    expect(
      await readFile(path.join(installedSkill, "SKILL.md"), "utf8"),
    ).toContain("# scratchpad");

    // Off again: hidden and refused, but not deleted; the skill goes.
    expect(await setEnabled(server.url, false)).toEqual({ enabled: false });
    expect(await (await get(server.url, "/sessions-api")).json()).toEqual([]);
    expect(
      (await get(server.url, `/sessions-api/${SCRATCHPAD_SESSION_ID}`)).status,
    ).toBe(409);
    expect(local.store.has(SCRATCHPAD_SESSION_ID)).toBe(true);
    expect(existsSync(installedSkill)).toBe(false);

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
