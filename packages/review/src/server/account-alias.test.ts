import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { aliasInstallationToAccount } from "./account-alias";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function home(signedIn: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alias-"));
  homes.push(dir);

  if (signedIn)
    await writeFile(
      path.join(dir, "auth.json"),
      JSON.stringify({
        origin: "https://app.dev.fast",
        token: "t",
        login: "alice",
        savedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

  return { DEV_REVIEW_HOME: dir };
}

describe("aliasInstallationToAccount", () => {
  it("asks the store which account the saved login is, and aliases it", async () => {
    const aliased: string[] = [];

    await aliasInstallationToAccount(
      { captureAccountAlias: async (id) => void aliased.push(id) },
      await home(true),
      async () => Response.json({ user: { id: "account-1", name: "alice" } }),
    );

    expect(aliased).toEqual(["account-1"]);
  });

  it("does nothing without a login or when the store fails", async () => {
    const aliased: string[] = [];

    const telemetry = {
      captureAccountAlias: async (id: string) => void aliased.push(id),
    };

    await aliasInstallationToAccount(telemetry, await home(false), async () =>
      Response.json({ user: { id: "account-1", name: "alice" } }),
    );
    await aliasInstallationToAccount(
      telemetry,
      await home(true),
      async () => new Response(null, { status: 500 }),
    );

    expect(aliased).toEqual([]);
  });
});
