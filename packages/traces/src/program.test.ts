import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  StoreClient,
  allowTraceRepository,
  clearTraceEnvCache,
  collectingWritable,
  runTraceSessions,
  traceCommandPrefix,
  writeStoreAuth,
} from "@dev.fast/trace-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type TracesCliRuntime, runTracesCli } from "./program";
import { shimPath } from "./self-install";

const ownCliPath = "/opt/npx-cache/node_modules/@dev.fast/traces/dist/cli.js";

const runningCommand = { file: "/opt/node/bin/node", args: [ownCliPath] };

// Not shimPath(homeDir): a test that asserts this path proves the program read
// the install result instead of deriving the path a second time.
const installedShim = "/installed/by/the/install/dev-traces";

/** The command names of one help text, without the built-in `help`. */
function commandNames(helpText: string): string[] {
  const start = helpText.indexOf("Commands:");
  const names = new Set<string>();

  for (const line of helpText.slice(start).split("\n").slice(1)) {
    const match = /^ {2}(\S+)/.exec(line);

    if (match && match[1] !== "help") names.add(match[1]);
  }

  return [...names];
}

describe("dev-traces program", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dev-traces-program-"));
    env = {
      HOME: home,
      DEV_REVIEW_HOME: path.join(home, ".dev"),
      PATH: "/usr/bin",
    };
  });

  afterEach(async () => {
    clearTraceEnvCache();
    await rm(home, { recursive: true, force: true });
  });

  function stubs(calls: string[]): Partial<TracesCliRuntime> {
    return {
      installSelf: vi.fn<TracesCliRuntime["installSelf"]>(async (input) => {
        calls.push("installSelf");

        return {
          version: "0.1.0",
          installedRoot: path.join(
            input.devHome,
            "traces",
            "versions",
            "0.1.0",
          ),
          copied: true,
          shimPath: installedShim,
          output: "[ok] installed\n",
        };
      }),
      selfInstallStatus: vi.fn<TracesCliRuntime["selfInstallStatus"]>(
        async (input) => {
          calls.push("selfInstallStatus");

          return {
            installed: true,
            installedVersion: "0.1.0",
            currentPath: path.join(input.devHome, "traces", "current"),
            shim: {
              path: shimPath(input.homeDir),
              present: true,
              owned: true,
              onPath: true,
              profiles: [],
            },
            runtimePath: "/opt/node/bin/node",
            lines: ["Installed: 0.1.0\n"],
          };
        },
      ),
      runTraceAllow: vi.fn<TracesCliRuntime["runTraceAllow"]>(async () => {
        calls.push("runTraceAllow");

        return 0;
      }),
      runTraceEnable: vi.fn<TracesCliRuntime["runTraceEnable"]>(async () => {
        calls.push("runTraceEnable");

        return 0;
      }),
      runTraceRepair: vi.fn<TracesCliRuntime["runTraceRepair"]>(async () => {
        calls.push("runTraceRepair");

        return 0;
      }),
      runTraceHook: vi.fn<TracesCliRuntime["runTraceHook"]>(async () => {
        calls.push("runTraceHook");

        return 0;
      }),
      runTraceList: vi.fn<TracesCliRuntime["runTraceList"]>(async () => {
        calls.push("runTraceList");

        return 0;
      }),
      runTraceStatus: vi.fn<TracesCliRuntime["runTraceStatus"]>(
        async (statusInput) => {
          calls.push("runTraceStatus");
          statusInput.stdout.write("Trace capture: enabled\n");

          return 0;
        },
      ),
    };
  }

  function run(
    argv: string[],
    runtime: Partial<TracesCliRuntime>,
    extra: { platform?: NodeJS.Platform; stdin?: Readable } = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];

    return {
      code: runTracesCli({
        argv,
        ownCliPath,
        cwd: home,
        env,
        homeDir: home,
        execPath: "/opt/node/bin/node",
        platform: extra.platform ?? "darwin",
        stdin: extra.stdin,
        stdout: collectingWritable(out),
        stderr: collectingWritable(err),
        runtime,
      }),
      out: () => out.join(""),
      err: () => err.join(""),
    };
  }

  it("accepts the background sync invocation with its storage guard", async () => {
    const sync = vi.fn<TracesCliRuntime["runTraceSync"]>(async () => 0);
    const session = "matrix-sync-0001";
    expect(
      await run(
        [
          "trace",
          "sync",
          session,
          "--expect-storage",
          "expected-store",
          "--json",
        ],
        { ...stubs([]), runTraceSync: sync },
      ).code,
    ).toBe(0);
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session,
        expectStorage: "expected-store",
        json: true,
      }),
    );
  });

  it("allow installs first and hands the shim to the runtime", async () => {
    const calls: string[] = [];
    const runtime = stubs(calls);
    const result = run(["allow", ".", "--json"], runtime);
    expect(await result.code).toBe(0);
    expect(calls).toEqual(["installSelf", "runTraceAllow"]);
    expect(runtime.runTraceAllow).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        traceCommand: { file: installedShim },
      }),
    );
    expect(result.err()).toContain("[ok] installed");
    expect(result.out()).not.toContain("[ok] installed");
  });

  it("allow --no-install skips the install and uses the running entry", async () => {
    const calls: string[] = [];
    const runtime = stubs(calls);
    expect(await run(["allow", ".", "--no-install"], runtime).code).toBe(0);
    expect(calls).toEqual(["runTraceAllow"]);
    expect(runtime.runTraceAllow).toHaveBeenCalledWith(
      expect.objectContaining({ traceCommand: runningCommand }),
    );
  });

  it("enable installs first and hands the shim to the runtime", async () => {
    const calls: string[] = [];
    const runtime = stubs(calls);
    expect(await run(["enable", "."], runtime).code).toBe(0);
    expect(calls).toEqual(["installSelf", "runTraceEnable"]);
    expect(runtime.runTraceEnable).toHaveBeenCalledWith(
      expect.objectContaining({ traceCommand: { file: installedShim } }),
    );
  });

  it("repair --no-install skips the install and uses the running entry", async () => {
    const calls: string[] = [];
    const runtime = stubs(calls);
    expect(await run(["repair", ".", "--no-install"], runtime).code).toBe(0);
    expect(calls).toEqual(["runTraceRepair"]);
    expect(runtime.runTraceRepair).toHaveBeenCalledWith(
      expect.objectContaining({ traceCommand: runningCommand }),
    );
  });

  it("trace hook forwards stdin and the running command", async () => {
    const runtime = stubs([]);

    const stdin = Readable.from([
      '{"hook_event_name":"SessionStart","session_id":"s1"}',
    ]);

    expect(
      await run(["trace", "hook", "SessionStart"], runtime, { stdin }).code,
    ).toBe(0);
    expect(runtime.runTraceHook).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "SessionStart",
        stdin,
        traceCommand: runningCommand,
      }),
    );
  });

  it.each([
    ["hook", ["trace", "hook", "SessionStart"]],
    ["git-hook", ["trace", "git-hook", "pre-push"]],
  ])("exits 0 with one line when %s throws", async (_name, argv) => {
    const failure = new Error("the store is unreachable");

    const runtime = {
      ...stubs([]),
      runTraceHook: vi.fn<TracesCliRuntime["runTraceHook"]>(async () => {
        throw failure;
      }),
      runTraceGitHook: vi.fn<TracesCliRuntime["runTraceGitHook"]>(async () => {
        throw failure;
      }),
    };

    const result = run(argv, runtime);
    expect(await result.code).toBe(0);
    expect(result.err()).toBe(
      "dev-traces: the hook failed: the store is unreachable\n",
    );
    expect(result.err()).not.toContain("at ");
  });

  it("emits one JSON error event for a usage error under --json", async () => {
    const result = run(["no-such-command", "--json"], stubs([]));
    expect(await result.code).toBe(1);
    const lines = result.out().trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event.event).toBe("error");
    expect(event.stage).toBe("usage");
    expect(event.message).toContain("no-such-command");
    expect(result.err()).toContain("Usage:");
  });

  it("reads one commit and never a Review", async () => {
    const calls: string[] = [];
    const runtime = stubs(calls);
    expect(await run(["list"], runtime).code).toBe(1);
    expect(calls).toEqual([]);

    expect(await run(["list", "--commit", "abc", "--json"], runtime).code).toBe(
      0,
    );
    expect(runtime.runTraceList).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { commit: "abc" }, json: true }),
    );
  });

  it("registers the repository shape without --review or --storage", async () => {
    const help = run(["--help"], stubs([]));
    expect(await help.code).toBe(0);
    const names = commandNames(help.out());
    expect(names).toContain("list");
    expect(names).toContain("pull");

    for (const name of names) {
      const result = run([name, "--help"], stubs([]));
      expect(await result.code).toBe(0);
      expect(result.out()).not.toContain("--review");
      expect(result.out()).not.toContain("--storage");
    }
  });

  it("uninstall removes the standalone install", async () => {
    const runtime = {
      ...stubs([]),
      uninstallSelf: vi.fn<TracesCliRuntime["uninstallSelf"]>(async () => ({
        removedShim: true,
        keptForeignShim: false,
        profiles: [],
        hooksRemoved: [],
        repositoriesDisabled: [],
        output: "Removed\n",
      })),
    };

    expect(await run(["uninstall"], runtime).code).toBe(0);
    expect(runtime.uninstallSelf).toHaveBeenCalledOnce();
  });

  it("install writes the command file first, then the harness hooks", async () => {
    // Only the harness with a home directory gets a hook.
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const calls: string[] = [];
    const runtime = stubs(calls);
    const result = run(["install"], runtime);
    expect(await result.code).toBe(0);
    expect(calls).toEqual(["installSelf"]);
    expect(runtime.installSelf).toHaveBeenCalledWith(
      expect.objectContaining({ force: false }),
    );

    const claudeSettings = path.join(home, ".claude", "settings.json");
    const text = result.out();
    expect(text.indexOf("[ok] installed")).toBeLessThan(
      text.indexOf("Harness hook: claude"),
    );

    expect(text).toContain(`Harness hook: claude -> ${claudeSettings}`);
    expect(text).not.toContain("Harness hook: codex -> ");
    expect(text).toContain(
      "Skipped the codex, opencode, pi hooks: this machine has no such harness.",
    );

    // The hooks must name the installed command file, never the npx cache.
    expect(await readFile(claudeSettings, "utf8")).toContain(installedShim);
    expect(text).not.toContain(ownCliPath);

    const help = run(["install", "--help"], stubs([]));
    expect(await help.code).toBe(0);
    expect(help.out()).toContain(
      "Install the agent hooks on this machine and the dev-traces command",
    );
  });

  it("install --all-harnesses writes every hook on a bare machine", async () => {
    const result = run(["install", "--all-harnesses"], stubs([]));
    expect(await result.code).toBe(0);
    const text = result.out();
    expect(text).toContain("Harness hook: claude -> ");
    expect(text).toContain("Harness hook: codex -> ");
    expect(text).toContain("Harness hook: opencode -> ");
    expect(text).toContain("Harness hook: pi -> ");
    expect(text).not.toContain("Skipped the");
  });

  it("install --force copies the running version again", async () => {
    const runtime = stubs([]);
    expect(await run(["install", "--force"], runtime).code).toBe(0);
    expect(runtime.installSelf).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("install --no-harness-hooks writes no hook", async () => {
    const calls: string[] = [];
    const result = run(["install", "--no-harness-hooks"], stubs(calls));
    expect(await result.code).toBe(0);
    expect(calls).toEqual(["installSelf"]);
    expect(result.out()).toContain("Harness hooks: skipped.");
    expect(result.out()).not.toContain("Harness hook: claude");
  });

  it("store create runs the onboarding action under the new name", async () => {
    const calls: string[] = [];

    const runtime: Partial<TracesCliRuntime> = {
      ...stubs(calls),
      runTraceOnboard: vi.fn<TracesCliRuntime["runTraceOnboard"]>(async () => {
        calls.push("runTraceOnboard");

        return 0;
      }),
    };

    expect(await run(["store", "create"], runtime).code).toBe(0);
    expect(calls).toEqual(["runTraceOnboard"]);
  });

  it("refuses allow on Windows", async () => {
    const calls: string[] = [];
    const result = run(["allow", "."], stubs(calls), { platform: "win32" });
    expect(await result.code).toBe(1);
    expect(result.err()).toBe("dev-traces supports macOS and Linux only.\n");
    expect(calls).toEqual([]);
  });

  it("refuses install on Windows", async () => {
    const calls: string[] = [];
    const result = run(["install"], stubs(calls), { platform: "win32" });
    expect(await result.code).toBe(1);
    expect(result.err()).toBe("dev-traces supports macOS and Linux only.\n");
    expect(calls).toEqual([]);
  });

  it("names its own root-level commands in the library hints", async () => {
    // The trailer comes from the library's real `runTraceSessions`; only the
    // store is faked.
    const origin = "https://app.dev.fast";
    execFileSync("git", ["init", "--quiet", home]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: home },
    );
    clearTraceEnvCache();

    await writeStoreAuth(
      { origin, token: "token", login: "dev", savedAt: "2026-09-01T00:00:00Z" },
      env,
    );
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin },
      path.join(home, ".dev"),
    );

    const client = new StoreClient({
      origin,
      token: "token",
      fetch: vi.fn<typeof fetch>(async (url) =>
        String(url).includes("/sessions")
          ? Response.json({
              sessions: [
                {
                  sessionId: "01a015e4-0477-7055-a0fd-21a0f72a4ec6",
                  harness: "claude",
                  uploadId: "fedcba9876543210fedcba9876543210",
                  generation: 1,
                  updatedAt: "2026-09-02T12:00:00.000Z",
                  commits: ["a".repeat(40)],
                  branch: "main",
                  author: "dev",
                  objects: [],
                },
              ],
              nextCursor: "01a015e4-0477-7055-a0fd-21a0f72a4ec6",
            })
          : Response.json({
              repositoryId: 7,
              storeId: "0123456789abcdef0123456789abcdef",
              displayName: "acme/app",
              status: "active",
              createdAt: "2026-09-01T00:00:00.000Z",
            }),
      ),
    });

    const result = run(["sessions", "--limit", "1"], {
      runTraceSessions: (sessionsInput) =>
        runTraceSessions({ ...sessionsInput, client }),
    });

    expect(await result.code).toBe(0);
    expect(traceCommandPrefix()).toBe("dev-traces");
    expect(result.out()).toContain(
      "run `dev-traces sessions --limit 1 --cursor ",
    );
    expect(result.out()).not.toContain("dev-traces trace");
  });

  it("prints the install status before the trace status", async () => {
    const calls: string[] = [];
    const result = run(["status"], stubs(calls));
    expect(await result.code).toBe(0);
    expect(calls).toEqual(["selfInstallStatus", "runTraceStatus"]);
    expect(result.out()).toBe("Installed: 0.1.0\nTrace capture: enabled\n");
  });
});
