import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { writeStoreAuth } from "./store-auth";
import { StoreClient } from "./store-client";
import {
  runReviewTraceDeny,
  runReviewTraceSessions,
  writeHostedTraceStatus,
} from "./trace-hosted-cli";
import { rememberTraceRepositoryTarget } from "./trace-repository-target";
import { traceConfigPath } from "./trace-storage/config";
import { allowTraceRepository, readTraceUserConfig } from "./trace-user-config";

const ORIGIN = "https://app.dev.fast";

const STORE_ID = "0123456789abcdef0123456789abcdef";

/** One stored object as the fake store answers it. */
interface FakeStoredObject {
  name: string;
  size: number;
  sha256: string;
  url: string;
  expiresAt: string;
}

/** One published session as the fake store answers it. */
interface FakeSession {
  sessionId: string;
  harness: string;
  uploadId: string;
  generation: number;
  updatedAt: string;
  commits: string[];
  branch: string | null;
  author: string | null;
  objects: FakeStoredObject[];
}

interface CollectedOutput {
  stream: Writable;
  text: () => string;
}

function collect(): CollectedOutput {
  let text = "";

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });

  return { stream, text: () => text };
}

describe("hosted trace commands", () => {
  let home: string;
  let repo: string;
  let devHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-hosted-cli-"));
    repo = path.join(home, "repo");
    devHome = path.join(home, ".dev");
    env = { DEV_REVIEW_HOME: devHome };
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: repo },
    );
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    rmSync(home, { recursive: true, force: true });
  });

  function client(handler: (url: string, init?: RequestInit) => Response) {
    return new StoreClient({
      origin: ORIGIN,
      token: "token",
      fetch: vi.fn<typeof fetch>(async (input, init) =>
        handler(String(input), init),
      ),
    });
  }

  const STORE = {
    repositoryId: 7,
    storeId: STORE_ID,
    displayName: "acme/app",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  function session(id: string, extra: Partial<FakeSession> = {}): FakeSession {
    return {
      sessionId: id,
      harness: "claude",
      uploadId: "fedcba9876543210fedcba9876543210",
      generation: 1,
      updatedAt: "2026-09-02T12:00:00.000Z",
      commits: ["a".repeat(40)],
      branch: "main",
      author: "dev",
      objects: [
        {
          name: "main.jsonl.gz",
          size: 1000,
          sha256: "a".repeat(64),
          url: "https://r2.test/secret-signed-url",
          expiresAt: "2026-09-02T12:15:00.000Z",
        },
        {
          name: "subagents/worker-1.jsonl.gz",
          size: 234,
          sha256: "b".repeat(64),
          url: "https://r2.test/another-secret",
          expiresAt: "2026-09-02T12:15:00.000Z",
        },
      ],
      ...extra,
    };
  }

  async function selectHosted(): Promise<void> {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    await writeStoreAuth(
      {
        origin: ORIGIN,
        token: "token",
        login: "dev",
        savedAt: "2026-09-01T00:00:00.000Z",
      },
      env,
    );
  }

  it("lists every published session with bytes and no signed URL", async () => {
    await selectHosted();
    const requests: string[] = [];
    const out = collect();
    const err = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      stdout: out.stream,
      stderr: err.stream,
      client: client((url) => {
        requests.push(url);

        if (url.includes("/stores?")) return Response.json(STORE);

        return Response.json({
          sessions: [
            session("session-0001"),
            session("session-0002", { branch: null }),
          ],
          nextCursor: "session-0002",
        });
      }),
    });

    expect(code).toBe(0);
    expect(requests.at(-1)).toContain("/stores/7/sessions?limit=50");
    expect(out.text()).toContain(
      "session-0001  claude  2026-09-02T12:00:00.000Z  main  1234 bytes",
    );
    expect(out.text()).toContain(
      "session-0002  claude  2026-09-02T12:00:00.000Z  -  1234 bytes",
    );
    expect(out.text()).toContain("--cursor session-0002");
    expect(out.text()).not.toContain("r2.test");
    expect(err.text()).toBe("");
  });

  it("prints one JSON event without signed URLs and forwards limit and cursor", async () => {
    await selectHosted();
    const requests: string[] = [];
    const out = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      json: true,
      limit: 2,
      cursor: "session-0002",
      stdout: out.stream,
      stderr: collect().stream,
      client: client((url) => {
        requests.push(url);

        if (url.includes("/stores?")) return Response.json(STORE);

        return Response.json({ sessions: [session("session-0003")] });
      }),
    });

    expect(code).toBe(0);
    expect(requests.at(-1)).toContain("limit=2");
    expect(requests.at(-1)).toContain("cursor=session-0002");
    const event = JSON.parse(out.text().trim());
    expect(event).toMatchObject({
      event: "trace.sessions",
      repository: "acme/app",
      repositoryId: 7,
      store: ORIGIN,
      nextCursor: null,
    });
    expect(event.sessions).toEqual([
      {
        id: "session-0003",
        harness: "claude",
        updatedAt: "2026-09-02T12:00:00.000Z",
        branch: "main",
        author: "dev",
        generation: 1,
        commits: ["a".repeat(40)],
        traces: ["main", "worker-1"],
        bytes: 1234,
      },
    ]);
    expect(out.text()).not.toContain("url");
  });

  it("reports an empty store as success", async () => {
    await selectHosted();
    const out = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      stdout: out.stream,
      stderr: collect().stream,
      client: client((url) =>
        url.includes("/stores?")
          ? Response.json(STORE)
          : Response.json({ sessions: [] }),
      ),
    });

    expect(code).toBe(0);
    expect(out.text()).toContain("No published sessions");
  });

  it("refuses the s3 store and a missing hosted configuration", async () => {
    const err = collect();
    expect(
      await runReviewTraceSessions({
        cwd: repo,
        env,
        homeDir: home,
        stdout: collect().stream,
        stderr: err.stream,
      }),
    ).toBe(1);
    expect(err.text()).toContain("Hosted trace storage is not configured");

    await selectHosted();
    const s3 = collect();
    expect(
      await runReviewTraceSessions({
        cwd: repo,
        env,
        homeDir: home,
        storage: "s3",
        stdout: collect().stream,
        stderr: s3.stream,
      }),
    ).toBe(1);
    expect(s3.text()).toContain("hosted store only");
  });

  it("names the hosted store, not the s3 credentials, when s3 is selected", async () => {
    const configPath = traceConfigPath({ env, homeDir: home });
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ version: 2, "current-store": "s3" }),
    );
    const err = collect();

    expect(
      await runReviewTraceSessions({
        cwd: repo,
        env,
        homeDir: home,
        stdout: collect().stream,
        stderr: err.stream,
      }),
    ).toBe(1);
    expect(err.text()).toContain("hosted store only");
    expect(err.text()).not.toContain("bucket credentials");
  });

  it("lists the hosted store with --storage hosted while the s3 selection is broken", async () => {
    const configPath = traceConfigPath({ env, homeDir: home });
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        "current-store": "s3",
        repositories: [
          {
            repositoryId: 7,
            name: "acme/app",
            enabledOrigins: [ORIGIN],
            allowedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const out = collect();
    const err = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      storage: "hosted",
      stdout: out.stream,
      stderr: err.stream,
      client: client((url) =>
        url.includes("/stores?")
          ? Response.json(STORE)
          : Response.json({
              sessions: [session("session-0001")],
              nextCursor: "session-0001",
            }),
      ),
    });

    expect(code).toBe(0);
    expect(err.text()).not.toContain("bucket credentials");
    expect(out.text()).toContain(
      "session-0001  claude  2026-09-02T12:00:00.000Z  main  1234 bytes",
    );
    // The next page needs the same override, or it fails on this machine.
    expect(out.text()).toContain(
      "review trace sessions --storage hosted --cursor session-0001",
    );
  });

  it("names a missing login instead of serving saved copies", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const err = collect();
    expect(
      await runReviewTraceSessions({
        cwd: repo,
        env,
        homeDir: home,
        stdout: collect().stream,
        stderr: err.stream,
      }),
    ).toBe(1);
    expect(err.text()).toContain(`review login --origin ${ORIGIN}`);
  });

  it("maps store refusals and an older store to explicit messages", async () => {
    await selectHosted();

    const envelope = (code: string, status: number) =>
      Response.json({ error: { code, message: "refused" } }, { status });

    const run = async (handler: (url: string) => Response) => {
      const err = collect();

      const code = await runReviewTraceSessions({
        cwd: repo,
        env,
        homeDir: home,
        json: true,
        stdout: collect().stream,
        stderr: err.stream,
        client: client(handler),
      });

      return { code, text: err.text() };
    };

    const unauthorized = await run(() => envelope("unauthorized", 401));
    expect(unauthorized.code).toBe(1);
    expect(unauthorized.text).toContain("rejected the login");

    const forbidden = await run((url) =>
      url.includes("/stores?")
        ? Response.json(STORE)
        : envelope("forbidden", 403),
    );

    expect(forbidden.text).toContain("cannot read the traces of acme/app");

    const deleted = await run(() =>
      Response.json({ ...STORE, status: "deleting" }),
    );

    expect(deleted.text).toContain("was deleted");

    const notOnboarded = await run(() => envelope("not_found", 404));
    expect(notOnboarded.text).toContain("not onboarded");

    const older = await run((url) =>
      url.includes("/stores?")
        ? Response.json(STORE)
        : envelope("invalid_request", 400),
    );

    expect(older.text).toContain("does not support listing every session");

    const offline = await run(() => {
      throw new TypeError("fetch failed");
    });

    expect(offline.text).toContain(
      `Could not reach the trace store at ${ORIGIN}`,
    );
  });

  it("refuses a page size outside the store's bounds before any call", async () => {
    await selectHosted();
    const requests: string[] = [];
    const err = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      limit: 0,
      stdout: collect().stream,
      stderr: err.stream,
      client: client((url) => {
        requests.push(url);

        throw new Error("the store must not be called");
      }),
    });

    expect(code).toBe(1);
    expect(err.text()).toContain(
      "--limit must be a whole number from 1 to 200.",
    );
    expect(requests).toEqual([]);
  });

  it("refuses a cursor that is no session id before any call", async () => {
    await selectHosted();
    const requests: string[] = [];
    const err = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      cursor: "bad cursor!",
      stdout: collect().stream,
      stderr: err.stream,
      client: client((url) => {
        requests.push(url);

        throw new Error("the store must not be called");
      }),
    });

    expect(code).toBe(1);
    expect(err.text()).toContain(
      "--cursor must be a session id from a previous page.",
    );
    expect(requests).toEqual([]);
  });

  it("keeps the page size in the next-page command", async () => {
    await selectHosted();
    const out = collect();

    const code = await runReviewTraceSessions({
      cwd: repo,
      env,
      homeDir: home,
      limit: 10,
      stdout: out.stream,
      stderr: collect().stream,
      client: client((url) =>
        url.includes("/stores?")
          ? Response.json(STORE)
          : Response.json({
              sessions: [session("session-0001")],
              nextCursor: "session-0001",
            }),
      ),
    });

    expect(code).toBe(0);
    expect(out.text()).toContain(
      "review trace sessions --limit 10 --cursor session-0001",
    );
  });

  it("deletes the store on request after withdrawing consent", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    await rememberTraceRepositoryTarget({
      cwd: repo,
      target: {
        origin: ORIGIN,
        repositoryId: 7,
        storeId: STORE_ID,
        name: "acme/app",
      },
      checkout: "acme/app",
      devHome,
    });
    const calls: string[] = [];
    const out = collect();

    const code = await runReviewTraceDeny({
      cwd: repo,
      env,
      homeDir: home,
      deleteStore: true,
      client: client((url, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);

        return Response.json({
          repositoryId: 7,
          storeId: STORE_ID,
          status: "deleting",
          deletedAt: "2026-09-09T00:00:00.000Z",
        });
      }),
      stdout: out.stream,
      stderr: out.stream,
    });

    expect(code).toBe(0);
    expect(calls).toEqual(["DELETE /api/trace/v1/stores/7"]);
    expect((await readTraceUserConfig(devHome)).repositories).toEqual([]);
    expect(out.text()).toContain("deletion requested");
  });

  it("prints the stored bytes of this repository's store", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const out = collect();
    await writeHostedTraceStatus({
      cwd: repo,
      env,
      homeDir: home,
      origin: ORIGIN,
      stdout: out.stream,
      client: client(() =>
        Response.json({
          repositoryId: 7,
          storeId: STORE_ID,
          displayName: "acme/app",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          bytesStored: 2048,
        }),
      ),
    });
    expect(out.text()).toContain("Stored bytes: 2048");
  });
});
