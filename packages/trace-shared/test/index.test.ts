import { describe, expect, it } from "vitest";

import {
  byCommitSchema,
  createSignedTraceToken,
  sessionMetaSchema,
  verifySignedTraceToken,
} from "../src/index.js";

const SECRET = "test-secret";
const FUTURE = new Date(Date.now() + 60_000);

describe("capability tokens", () => {
  it("round-trips an authentic token", async () => {
    const token = await createSignedTraceToken({
      owner: "Fix-Fast",
      repo: "dev",
      access: "write",
      expiresAt: FUTURE,
      secret: SECRET,
    });
    const payload = await verifySignedTraceToken({ token, secret: SECRET });
    expect(payload).toMatchObject({
      owner: "fix-fast",
      repo: "dev",
      access: "write",
    });
  });

  it("survives repo names with dots", async () => {
    const token = await createSignedTraceToken({
      owner: "vercel",
      repo: "next.js",
      access: "read",
      expiresAt: FUTURE,
      secret: SECRET,
    });
    const payload = await verifySignedTraceToken({ token, secret: SECRET });
    expect(payload?.repo).toBe("next.js");
  });

  it("rejects an expired token", async () => {
    const token = await createSignedTraceToken({
      owner: "Fix-Fast",
      repo: "dev",
      access: "read",
      expiresAt: new Date(Date.now() - 1_000),
      secret: SECRET,
    });
    expect(await verifySignedTraceToken({ token, secret: SECRET })).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createSignedTraceToken({
      owner: "Fix-Fast",
      repo: "dev",
      access: "read",
      expiresAt: FUTURE,
      secret: SECRET,
    });
    const [version, payload, signature] = token.split(".");
    const forged = btoa(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")).replace(
        '"read"',
        '"write"',
      ),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifySignedTraceToken({
        token: `${version}.${forged}.${signature}`,
        secret: SECRET,
      }),
    ).toBeNull();
  });

  it("rejects the wrong secret and malformed tokens", async () => {
    const token = await createSignedTraceToken({
      owner: "Fix-Fast",
      repo: "dev",
      access: "read",
      expiresAt: FUTURE,
      secret: SECRET,
    });
    expect(await verifySignedTraceToken({ token, secret: "other" })).toBeNull();
    expect(
      await verifySignedTraceToken({ token: "v1.garbage", secret: SECRET }),
    ).toBeNull();
    expect(
      await verifySignedTraceToken({ token: "v2.a.b", secret: SECRET }),
    ).toBeNull();
  });
});

describe("stored object schemas", () => {
  it("parses a live by-commit entry shape", () => {
    const entry = byCommitSchema.parse({
      commit: "30a8056bd32bf5686b7094e3b19c3e07aa9ff17c",
      sessions: ["49df4ae6-a245-4f47-94b8-183928fcefd0"],
      repo: "Fix-Fast/dev",
      pr: 875,
      branch: "main",
      indexed_by: "ci",
      ts: "2026-08-10T20:39:16Z",
    });
    expect(entry.sessions).toHaveLength(1);
  });

  it("parses session meta with nullable fields", () => {
    const meta = sessionMetaSchema.parse({
      session: "49df4ae6-a245-4f47-94b8-183928fcefd0",
      repo: null,
      branch: null,
      pr: null,
      commits: [],
      author: null,
      ts: "2026-08-10T20:39:16Z",
    });
    expect(meta.commits).toEqual([]);
  });
});

describe("tenant casing", () => {
  it("normalizes owner and repo to lowercase at the schema", async () => {
    const token = await createSignedTraceToken({
      owner: "Fix-Fast",
      repo: "Next.JS",
      access: "read",
      expiresAt: FUTURE,
      secret: SECRET,
    });
    const payload = await verifySignedTraceToken({ token, secret: SECRET });
    expect(payload).toMatchObject({ owner: "fix-fast", repo: "next.js" });
  });
});
