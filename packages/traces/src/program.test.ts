import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { collectingWritable } from "@dev.fast/trace-core";
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

  it("keeps the trace group identical to the library hook commands", async () => {
    // The hidden group forwards to the same runtime, so its arguments and
    // options must not drift from the ones the library registers.
    const onOneLine = (text: string): string =>
      text.replaceAll("dev-traces trace ", "dev-traces ");

    for (const name of ["hook", "git-hook"]) {
      const direct = run([name, "--help"], stubs([]));
      expect(await direct.code).toBe(0);

      const grouped = run(["trace", name, "--help"], stubs([]));
      expect(await grouped.code).toBe(0);
      expect(onOneLine(grouped.out())).toBe(onOneLine(direct.out()));
    }
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

  it("prints the install status before the trace status", async () => {
    const calls: string[] = [];
    const result = run(["status"], stubs(calls));
    expect(await result.code).toBe(0);
    expect(calls).toEqual(["selfInstallStatus", "runTraceStatus"]);
    expect(result.out()).toBe("Installed: 0.1.0\nTrace capture: enabled\n");
  });
});
