import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "../review-agent-traces";
import { createReviewDir } from "../review-home";
import { writeStoreAuth } from "../store-auth";
import { traceConfigPath } from "../trace-storage/config";
import { createReviewApi } from "./review-api";

const execFilePromise = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("agent trace routes", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "review-api-traces-home-"));
    root = await mkdtemp(path.join(os.tmpdir(), "review-api-traces-repo-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    vi.stubEnv("REVIEW_TEST_TRACE_SEARCH_DIR", path.join(home, "trace-search"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "review@example.test"]);
    await git(root, ["config", "user.name", "Review Test"]);
    await git(root, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
    await writeFile(path.join(root, "README.md"), "# Review\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);
    clearTraceEnvCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearTraceEnvCache();
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  async function writeTraceConfig(value: JsonValue): Promise<void> {
    const filePath = traceConfigPath({ devHome: home });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value), "utf8");
    clearTraceEnvCache();
  }

  async function api() {
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: commit,
      sourceCommit: commit,
    });
    const reviewPath = path.join(created.dir, "review.mdx");
    await writeFile(reviewPath, "# Review\n", "utf8");
    return createReviewApi({
      mode: { kind: "live" },
      reviewPath,
      stateReviewPath: reviewPath,
      reviewRootPath: created.dir,
      reviewDocumentsDir: created.dir,
      rootPath: root,
      toolingRoot: root,
      reviewToken: "test",
      session: {
        rootPath: root,
        baseRef: "main",
        appUrl: "http://localhost:4000",
        reviewPath,
        startedAt: 1,
        agent: { harness: "claude-code", sessionId: "author" },
      },
      agentServer: () => {
        throw new Error("no agent server in this test");
      },
      openNativeAgentTerminal: async () => undefined,
    });
  }

  it("rejects an unknown ?storage= value", async () => {
    const response = await (
      await api()
    ).app.request("/agent-traces?storage=direct");
    expect(response.status).toBe(400);
  });

  it("names a missing login when the hosted source is requested", async () => {
    await writeTraceConfig({ version: 2, "current-store": "hosted" });
    const response = await (
      await api()
    ).app.request("/agent-traces?storage=hosted");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      storage: "hosted",
      sessions: [],
      storageError: expect.stringContaining("review login"),
    });
  });

  it("names a malformed config instead of calling it unconfigured", async () => {
    await writeTraceConfig({
      version: 2,
      stores: {
        s3: {
          endpoint: "https://s3.example.invalid",
          bucket: "b",
          accessKeyId: "k",
          secretAccessKey: "s",
        },
        hosted: {},
      },
    });
    const response = await (await api()).app.request("/agent-traces");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      configured: false,
      sessions: [],
      storageError: expect.stringContaining("current-store"),
    });
  });

  it("reports a refusal on the detail route as not found with the reason", async () => {
    await writeTraceConfig({ version: 2, "current-store": "hosted" });
    await writeStoreAuth(
      {
        origin: "https://app.dev.fast",
        token: "t",
        login: "dev",
        savedAt: "2026-09-02T00:00:00Z",
      },
      process.env,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "forbidden",
              message: "You cannot use this repository.",
            },
          },
          { status: 403 },
        ),
      ),
    );
    const response = await (
      await api()
    ).app.request("/agent-traces/hosted-session-0001");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("cannot use this repository"),
    });
  });
});
