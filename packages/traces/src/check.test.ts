import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  StoreClient,
  allowTraceRepository,
  clearTraceEnvCache,
  collectingWritable,
  enableTraceRepository,
  recordTraceSyncFailure,
  traceScope,
  writeStoreAuth,
} from "@dev.fast/trace-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTracesCheck } from "./check";
import { installSelf, shimPath } from "./self-install";

const ORIGIN = "https://app.dev.fast";

const SESSION_ID = "01a015e4-0477-7055-a0fd-21a0f72a4ec6";

const STORE = {
  repositoryId: 7,
  storeId: "0123456789abcdef0123456789abcdef",
  displayName: "acme/app",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const SESSION = {
  sessionId: SESSION_ID,
  harness: "claude",
  uploadId: "fedcba9876543210fedcba9876543210",
  generation: 1,
  updatedAt: "2026-09-02T12:00:00.000Z",
  commits: ["a".repeat(40)],
  branch: "main",
  author: "dev",
  objects: [],
};

interface CheckEvent {
  event: string;
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string; fix?: string }[];
}

describe("dev-traces check", () => {
  let home: string;
  let devHome: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dev-traces-check-"));
    devHome = path.join(home, ".dev");
    repo = path.join(home, "repo");

    env = {
      HOME: home,
      DEV_REVIEW_HOME: devHome,
      PATH: `${path.join(home, ".local", "bin")}:/usr/bin:/bin`,
      SHELL: "/bin/zsh",
    };
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: repo },
    );
    clearTraceEnvCache();
  });

  afterEach(async () => {
    clearTraceEnvCache();
    await rm(home, { recursive: true, force: true });
  });

  function client(handler: (url: string) => Response): StoreClient {
    return new StoreClient({
      origin: ORIGIN,
      token: "token",
      fetch: vi.fn<typeof fetch>(async (input) => handler(String(input))),
    });
  }

  function healthyClient(): StoreClient {
    return client((url) => {
      if (url.includes("/api/auth/get-session")) {
        return Response.json({ user: { name: "dev" } });
      }

      if (url.includes("/sessions")) {
        return Response.json({ sessions: [SESSION] });
      }

      return Response.json(STORE);
    });
  }

  async function writeLogin(): Promise<void> {
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

  async function writeConsent(): Promise<void> {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
  }

  /** Installs the package, the Claude hook, and the Git hooks of this repo. */
  async function installEverything(): Promise<void> {
    const packageRoot = path.join(home, "pkg");
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });

    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@dev.fast/traces", version: "0.1.0" }),
    );
    await writeFile(path.join(packageRoot, "dist", "cli.js"), "");

    await installSelf({
      packageRoot,
      homeDir: home,
      env,
      devHome,
      execPath: process.execPath,
      force: false,
    });

    const shim = shimPath(home);

    const hook = (event: string) => ({
      hooks: [{ type: "command", command: `'${shim}' trace hook ${event}` }],
    });

    await mkdir(path.join(home, ".claude"), { recursive: true });

    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [hook("SessionStart")],
          UserPromptSubmit: [hook("UserPromptSubmit")],
          SessionEnd: [hook("SessionEnd")],
        },
      }),
    );

    await enableTraceRepository({
      cwd: repo,
      scope: traceScope({ homeDir: home, env }),
      reviewCommand: { file: shim },
    });
  }

  function check(storeClient: StoreClient, json = false) {
    const out: string[] = [];
    const err: string[] = [];

    return {
      code: runTracesCheck({
        scope: traceScope({ homeDir: home, env }),
        cwd: repo,
        ownCliPath: path.join(home, "pkg", "dist", "cli.js"),
        runningVersion: "0.1.0",
        json,
        stdout: collectingWritable(out),
        stderr: collectingWritable(err),
        client: storeClient,
      }),
      out: () => out.join(""),
      err: () => err.join(""),
    };
  }

  it("passes every check on a machine that is set up", async () => {
    await writeLogin();
    await writeConsent();
    await installEverything();
    const result = check(healthyClient(), true);
    expect(await result.code).toBe(0);
    const event: CheckEvent = JSON.parse(result.out().trim());
    expect(event.event).toBe("trace.check");
    expect(event.ok).toBe(true);

    expect(event.checks.map((entry) => [entry.name, entry.ok])).toEqual([
      ["runtime", true],
      ["install", true],
      ["login", true],
      ["repository", true],
      ["consent", true],
      ["hooks", true],
      ["activity", true],
    ]);
    expect(event.checks[6]?.detail).toContain(`newest published ${SESSION_ID}`);
    expect(result.err()).not.toContain("FAIL");
    expect(result.err()).toContain("All checks passed.");
  });

  it("fails without consent and names allow", async () => {
    await writeLogin();
    await installEverything();
    const result = check(healthyClient());
    expect(await result.code).toBe(1);

    expect(result.out()).toContain(
      `FAIL  consent: acme/app is not allowed at ${ORIGIN}\n      fix: dev-traces allow .\n`,
    );
  });

  it("fails on an expired login and names login", async () => {
    await writeLogin();
    await writeConsent();
    await installEverything();

    const result = check(
      client((url) =>
        url.includes("/api/auth/get-session")
          ? Response.json(
              { error: { code: "unauthorized", message: "expired" } },
              { status: 401 },
            )
          : Response.json(STORE),
      ),
    );

    expect(await result.code).toBe(1);
    expect(result.out()).toContain(`FAIL  login: the login for ${ORIGIN}`);
    expect(result.out()).toContain(
      `      fix: dev-traces login --origin ${ORIGIN}\n`,
    );
    expect(result.out()).toContain("FAIL  repository: skipped: no login");
  });

  it("fails the activity check on a recorded sync failure", async () => {
    await writeLogin();
    await writeConsent();
    await installEverything();

    await recordTraceSyncFailure({
      sessionId: SESSION_ID,
      repository: "acme/app",
      error: "the store refused the upload",
      devHome,
    });

    const result = check(healthyClient());
    expect(await result.code).toBe(1);
    expect(result.out()).toContain(`FAIL  activity:`);
    expect(result.out()).toContain(
      `      fix: dev-traces sync ${SESSION_ID}\n`,
    );
  });
});
