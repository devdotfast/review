import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { clearTraceEnvCache, writeStoreAuth } from "@dev.fast/trace-core";
import { parseWhiteboardAgentTraceResponse } from "@dev.fast/whiteboard-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createSessionApi } from "./http.js";
import { openLocalSessionStore } from "./local-data.js";

let root: string;

let local: ReturnType<typeof openLocalSessionStore>;

let api: ReturnType<typeof createSessionApi>;

let id: string;

const session = "72b3d130-2e72-41b6-8686-527a93d16647";

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "json-review-traces-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("DEV_WHITEBOARD_HOME", root);
  vi.stubEnv("WHITEBOARD_TEST_TRACE_SEARCH_DIR", path.join(root, "search"));
  vi.stubEnv("TRACE_R2_MODE", "mock");
  vi.stubEnv("TRACE_R2_MOCK_DIR", path.join(root, "bucket"));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("remote", "add", "origin", "git@github.com:acme/app.git");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "Base",
  );
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    `Change\n\nAgent-Session: ${session}`,
  );
  const dir = path.join(root, "bucket/by-session", session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "trace.jsonl"),
    [
      {
        type: "session",
        id: session,
        cwd: root,
        timestamp: "2026-09-16T12:00:00Z",
      },
      {
        type: "message",
        timestamp: "2026-09-16T12:00:01Z",
        message: { role: "user", content: "Recover my stored trace" },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  clearTraceEnvCache();
  local = openLocalSessionStore(path.join(root, "review.db"));
  const repo = await local.data.register(root);
  const pins = await local.data.resolvePins(repo.id, "HEAD^", "HEAD");

  const result = await local.store.execute({
    commandId: randomUUID(),
    operation: { type: "create", title: "Trace test", pins },
  });

  id = result.sessionId;
  api = createSessionApi(local.store, local.data);
});

afterEach(async () => {
  await local.store.close();
  await local.data.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearTraceEnvCache();
  rmSync(root, { recursive: true, force: true });
});

it("finds a pinned commit's stored session and reads its events without embedded trace blocks", async () => {
  const response = await api.request(`/${id}/agent-traces?version=0`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    sessions: [{ sessionId: session, available: true }],
  });
  const detail = await api.request(`/${id}/agent-traces/${session}?version=0`);
  expect(detail.status).toBe(200);
  const parsed = parseWhiteboardAgentTraceResponse(await detail.json());
  expect(parsed).toMatchObject({
    ok: true,
    events: [{ kind: "user", text: "Recover my stored trace" }],
  });
  expect(local.store.read(id).document).toEqual([]);
});

it("rejects invalid source overrides and missing reviews", async () => {
  expect((await api.request(`/${id}/agent-traces?storage=other`)).status).toBe(
    400,
  );
  expect((await api.request(`/missing/agent-traces`)).status).toBe(404);
});

it("reports hosted read denial rather than falling back to the direct store", async () => {
  vi.stubEnv("TRACE_R2_MODE", "");
  mkdirSync(path.join(root, "trace"), { recursive: true });
  writeFileSync(
    path.join(root, "trace/config.json"),
    JSON.stringify({ version: 2, "current-store": "hosted" }),
  );
  await writeStoreAuth(
    {
      origin: "https://app.dev.fast",
      token: "test",
      login: "test",
      savedAt: "2026-09-16T00:00:00Z",
    },
    process.env,
  );
  clearTraceEnvCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: { code: "forbidden", message: "Admin access required" } },
        { status: 403 },
      ),
    ),
  );
  const response = await api.request(`/${id}/agent-traces?storage=hosted`);
  expect(await response.json()).toMatchObject({
    ok: true,
    storage: "hosted",
    sessions: [],
    storageError: expect.stringContaining("Admin access required"),
  });

  const detail = await api.request(
    `/${id}/agent-traces/${session}?storage=hosted`,
  );

  expect(detail.status).toBe(403);
  expect(await detail.json()).toMatchObject({
    ok: false,
    error: expect.stringContaining("Admin access required"),
  });
});

it("distinguishes a missing transcript from invalid storage configuration", async () => {
  const missing = await api.request(
    `/${id}/agent-traces/00000000-0000-4000-8000-000000000000`,
  );

  expect(missing.status).toBe(404);
  mkdirSync(path.join(root, "trace"), { recursive: true });
  writeFileSync(path.join(root, "trace/config.json"), "invalid json");
  clearTraceEnvCache();
  const invalid = await api.request(`/${id}/agent-traces/${session}`);
  expect(invalid.status).toBe(400);
});
