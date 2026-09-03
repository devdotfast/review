import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStoreAuth, runReviewLogin, writeStoreAuth } from "./store-auth";

function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function outputStream(): PassThrough {
  return new PassThrough();
}

describe("store-auth", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "review-store-auth-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes auth.json under DEV_REVIEW_HOME with mode 0600", async () => {
    vi.stubEnv("DEV_REVIEW_HOME", tmp);
    await writeStoreAuth({
      origin: "https://app.dev.fast",
      token: "t",
      login: "dev",
      savedAt: "2026-09-02T00:00:00Z",
    });
    const fileStat = await stat(path.join(tmp, "auth.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(await readStoreAuth()).toMatchObject({ token: "t" });
  });

  it("completes a device login and stores the token", async () => {
    vi.stubEnv("DEV_REVIEW_HOME", tmp);
    const stdout = outputStream();
    const stderr = outputStream();
    const responses = [
      json({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri_complete:
          "https://app.dev.fast/device?user_code=ABCD-1234",
        expires_in: 900,
        interval: 1,
      }),
      json({ error: "authorization_pending" }, 400),
      json({ access_token: "tok", token_type: "Bearer" }),
      json({ user: { name: "dev" } }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => responses.shift()!,
    );
    const opened: string[] = [];
    const code = await runReviewLogin({
      stdout,
      stderr,
      fetch,
      openUrl: async (u) => {
        opened.push(u);
      },
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(opened[0]).toContain("user_code=ABCD-1234");
    expect((await readStoreAuth())?.token).toBe("tok");
  });
});
