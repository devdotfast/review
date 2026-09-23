import { PassThrough } from "node:stream";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { traceScope } from "./trace-command";
import {
  type TraceCommandRuntime,
  registerTraceCommands,
} from "./trace-commands";

const runtime: TraceCommandRuntime = {
  runTraceStatus: async () => 0,
  runTraceEnable: async () => 0,
  runTraceDisable: async () => 0,
  runTraceRepair: async () => 0,
  runTraceList: async () => 0,
  runTraceShow: async () => 0,
  runTracePull: async () => 0,
  runTraceBlame: async () => 0,
  runTraceHook: async () => 0,
  runTraceGitHook: async () => 0,
  runTraceSync: async () => 0,
  runTraceOnboard: async () => 0,
  runTraceStoreDelete: async () => 0,
  runTraceStoreInfo: async () => 0,
  runTraceInstallMachine: async () => 0,
  runTraceSessions: async () => 0,
  runTraceAllow: async () => 0,
  runTraceDeny: async () => 0,
};

const scope = traceScope({ homeDir: "/task17-home", env: {} });

const traceCommand = { file: "/opt/bin/traces", args: ["trace"] };

function build(overrides: Partial<TraceCommandRuntime> = {}) {
  const parent = new Command("trace").exitOverride();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const result = { code: -1, out: "", err: "" };
  stdout.on("data", (chunk) => {
    result.out += chunk;
  });
  stderr.on("data", (chunk) => {
    result.err += chunk;
  });
  registerTraceCommands(parent, {
    runtime: { ...runtime, ...overrides },
    traceCommand,
    scope,
    cwd: "/repo",
    stdin,
    stdout,
    stderr,
    configureOutput: (command) =>
      command.configureOutput({
        writeOut: (message) => stdout.write(message),
        writeErr: (message) => stderr.write(message),
      }),
    configureJsonOutput: (command) => command.option("--json"),
    setExitCode: (code) => {
      result.code = code;
    },
  });

  return {
    parent,
    stdout,
    stderr,
    stdin,
    result,
    parse: (argv: string[]) => parent.parseAsync(argv, { from: "user" }),
  };
}

describe("shared trace command parsing", () => {
  it("forwards hosted status filters with explicit scope and preserves runtime output and exit code", async () => {
    const fixture = build({
      runTraceStatus: async (input) => {
        expect(input).toEqual({
          scope,
          cwd: "/repo",
          session: "session-1",
          cursor: "page-2",
          limit: 7,
          stdout: fixture.stdout,
          stderr: fixture.stderr,
        });
        input.stdout.write("Upload pending\n");
        input.stderr.write("Try again\n");

        return 8;
      },
    });

    await fixture.parse([
      "status",
      "--agent-session",
      "session-1",
      "--cursor",
      "page-2",
      "--limit",
      "7",
    ]);
    expect(fixture.result).toEqual({
      code: 8,
      out: "Upload pending\n",
      err: "Try again\n",
    });
  });
  it("forwards commit list", async () => {
    const fixture = build({
      runTraceList: async (input) => {
        expect(input).toMatchObject({
          cwd: "/repo",
          commitSha: "HEAD~2",
          storage: "hosted",
          json: true,
        });
        input.stdout.write('{"event":"trace.list"}\n');

        return 3;
      },
    });

    await fixture.parse([
      "list",
      "--commit",
      "HEAD~2",
      "--storage",
      "hosted",
      "--json",
    ]);
    expect(fixture.result).toEqual({
      code: 3,
      out: '{"event":"trace.list"}\n',
      err: "",
    });
  });
  it("retains Review selection and pull wrapper inputs", async () => {
    const fixture = build({
      runTracePull: async (input) => {
        expect(input).toMatchObject({
          cwd: "/repo",
          repo: "owner/repo",
          sessionId: "uuid",
          mainOnly: true,
          storage: "s3",
          json: true,
        });
        input.stdout.write("pulled\n");

        return 0;
      },
    });

    await fixture.parse([
      "pull",
      "--repo",
      "owner/repo",
      "--session",
      "uuid",
      "--main-only",
      "--storage",
      "s3",
      "--json",
    ]);
    expect(fixture.result).toEqual({ code: 0, out: "pulled\n", err: "" });
  });
  it.each([
    ["list", "--session", "uuid", "--commit", "HEAD"],
    ["pull", "--session", "uuid", "--agent-session", "s"],
    ["pull", "--commit", "HEAD", "--agent-session", "s"],
  ])("rejects conflicting selectors %j", async (...argv) => {
    const fixture = build();
    await expect(fixture.parse(argv)).rejects.toThrow(
      argv[0] === "list"
        ? "Use either --session or --commit, not both."
        : "Use only one of --session, --commit, or --agent-session.",
    );
    expect(fixture.result.code).toBe(-1);
  });
  it("preserves hosted pagination parsing and errors", async () => {
    const fixture = build({
      runTraceSessions: async (input) => {
        expect(input).toMatchObject({
          scope,
          cwd: "/repo",
          limit: 12,
          cursor: "after",
          storage: "hosted",
          json: true,
        });

        return 4;
      },
    });

    await fixture.parse([
      "sessions",
      "--limit",
      "12",
      "--cursor",
      "after",
      "--storage",
      "hosted",
      "--json",
    ]);
    expect(fixture.result.code).toBe(4);
    const invalid = build();
    await expect(
      invalid.parse(["sessions", "--limit", "50junk"]),
    ).rejects.toThrow("--limit must be a whole number");
    expect(invalid.result.code).toBe(-1);
  });
  it.each([true, false])(
    "preserves allow path and harness default (%s)",
    async (harnessHooks) => {
      const fixture = build({
        runTraceAllow: async (input) => {
          expect(input).toMatchObject({
            scope,
            cwd: "/repo/child",
            harnessHooks,
            traceCommand,
          });

          return 5;
        },
      });

      await fixture.parse([
        "allow",
        "child",
        ...(harnessHooks ? [] : ["--no-harness-hooks"]),
      ]);
      expect(fixture.result.code).toBe(5);
    },
  );
  it("passes hidden hook arguments and stdin without changing the command", async () => {
    const fixture = build({
      runTraceGitHook: async (input) => {
        expect(input).toMatchObject({
          scope,
          cwd: "/repo",
          hook: "post-checkout",
          args: ["old", "new", "1"],
          stdin: fixture.stdin,
          traceCommand,
        });

        return 0;
      },
    });

    await fixture.parse(["git-hook", "post-checkout", "old", "new", "1"]);
    expect(fixture.result.code).toBe(0);
  });
  it("runs the store verbs against the given path", async () => {
    const seen: string[] = [];

    const fixture = build({
      runTraceOnboard: async (input) => {
        seen.push(`create ${input.cwd}`);

        return 0;
      },
      runTraceStoreDelete: async (input) => {
        seen.push(`delete ${input.cwd}`);

        return 0;
      },
      runTraceStoreInfo: async (input) => {
        seen.push(`info ${input.cwd} json=${input.json === true}`);

        return 2;
      },
    });

    await fixture.parse(["store", "create", "child"]);
    await fixture.parse(["store", "delete"]);
    await fixture.parse(["store", "info", "--json"]);
    expect(seen).toEqual([
      "create /repo/child",
      "delete /repo",
      "info /repo json=true",
    ]);
    expect(fixture.result.code).toBe(2);
  });

  it("refuses the removed deny option", async () => {
    const fixture = build();
    await expect(fixture.parse(["deny", "--delete-store"])).rejects.toThrow(
      "unknown option",
    );
    expect(fixture.result.code).toBe(-1);
  });
  it("renders repository help and hides hook commands", () => {
    const fixture = build();
    expect(fixture.parent.helpInformation()).toContain("status");
    expect(fixture.parent.helpInformation()).not.toContain("git-hook");
    expect(fixture.parent.helpInformation()).not.toContain("hook <event>");
  });
  it("renders explicit hidden hook help", async () => {
    const fixture = build();
    await expect(fixture.parse(["hook", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(fixture.result.out).toContain(
      "Handle agent session lifecycle hooks",
    );
    expect(fixture.result.code).toBe(-1);
  });
});
