import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeStoreAuth } from "@dev.fast/trace-core";
import { expect, it } from "vitest";

import { readSharingAuth } from "./auth.js";

it("uses explicit CI credentials without altering saved login and never silently falls back from invalid env", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-sharing-auth-"));
  const env = { DEV_WHITEBOARD_HOME: home };

  try {
    const saved = {
      origin: "https://saved.test",
      token: "saved-token",
      login: "saved-user",
      savedAt: "today",
    };

    await writeStoreAuth(saved, env);
    expect(await readSharingAuth(env)).toEqual(saved);
    expect(
      await readSharingAuth({
        ...env,
        DEV_WHITEBOARD_SHARE_TOKEN: "ci-token",
        DEV_WHITEBOARD_SHARE_ORIGIN: "https://ci.test",
      }),
    ).toEqual({ origin: "https://ci.test", token: "ci-token" });
    expect(
      JSON.parse(await readFile(path.join(home, "auth.json"), "utf8")),
    ).toEqual(saved);
    await expect(
      readSharingAuth({ ...env, DEV_WHITEBOARD_SHARE_TOKEN: "" }),
    ).rejects.toThrow(/empty/);
    await expect(
      readSharingAuth({ ...env, DEV_WHITEBOARD_SHARE_ORIGIN: "https://ci.test" }),
    ).rejects.toThrow(/requires/);
    await expect(
      readSharingAuth({
        ...env,
        DEV_WHITEBOARD_SHARE_TOKEN: "ci-token",
        DEV_WHITEBOARD_SHARE_ORIGIN: "https://user:password@ci.test/path",
      }),
    ).rejects.toThrow(/bare HTTPS origin/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
