import { PassThrough } from "node:stream";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { traceScope } from "./trace-command";
import {
  type TraceCommandRuntime,
  registerTraceCommands,
} from "./trace-commands";

const runtime: TraceCommandRuntime = {
  runReviewTraceStatus: async () => 0,
  runReviewTraceEnable: async () => 0,
  runReviewTraceDisable: async () => 0,
  runReviewTraceRepair: async () => 0,
  runReviewTraceList: async () => 0,
  runReviewTraceShow: async () => 0,
  runReviewTracePull: async () => 0,
  runReviewTraceBlame: async () => 0,
  runReviewTraceHook: async () => 0,
  runReviewTraceGitHook: async () => 0,
  runReviewTraceSync: async () => 0,
  runReviewTraceOnboard: async () => 0,
  runReviewTraceSessions: async () => 0,
  runReviewTraceAllow: async () => 0,
  runReviewTraceDeny: async () => 0,
};

const scope = traceScope({ homeDir: "/task17-home", env: {} });

const traceCommand = { file: "/opt/bin/traces", args: ["trace"] };

function build(
  reads: "review" | "repository" = "review",
  storageOverride = true,
  overrides: Partial<TraceCommandRuntime> = {},
) {
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
    cliName: reads === "review" ? "review" : "dev-traces",
    reads,
    storageOverride,
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
    const fixture = build("review", true, {
      runReviewTraceStatus: async (input) => {
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
      "--session",
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
  it.each<"review" | "repository">(["review", "repository"])(
    "forwards commit list in %s audience",
    async (reads) => {
      const fixture = build(reads, true, {
        runReviewTraceList: async (input) => {
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
    },
  );
  it("retains Review selection and pull wrapper inputs", async () => {
    const fixture = build("review", true, {
      runReviewTracePull: async (input) => {
        expect(input).toMatchObject({
          cwd: "/repo",
          repo: "owner/repo",
          reviewUuid: "uuid",
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
      "--review",
      "uuid",
      "--main-only",
      "--storage",
      "s3",
      "--json",
    ]);
    expect(fixture.result).toEqual({ code: 0, out: "pulled\n", err: "" });
  });
  it.each([
    ["list"],
    ["list", "--commit", "HEAD", "--review", "uuid"],
    ["pull", "--review", "uuid"],
    ["show", "s", "--storage", "hosted"],
    ["blame", "file", "--storage", "s3"],
    ["sessions", "--storage", "hosted"],
  ])("rejects unavailable repository arguments %j", async (...argv) => {
    const fixture = build("repository", false);
    await expect(fixture.parse(argv)).rejects.toThrow(
      argv.length === 1
        ? "required option '--commit <sha>' not specified"
        : "unknown option",
    );
    expect(fixture.result.code).toBe(-1);
  });
  it.each([
    ["list", "--review", "uuid", "--commit", "HEAD"],
    ["pull", "--review", "uuid", "--session", "s"],
    ["pull", "--commit", "HEAD", "--session", "s"],
  ])("rejects conflicting selectors %j", async (...argv) => {
    const fixture = build();
    await expect(fixture.parse(argv)).rejects.toThrow(
      argv[0] === "list"
        ? "Use either --review or --commit, not both."
        : "Use only one of --review, --commit, or --session.",
    );
    expect(fixture.result.code).toBe(-1);
  });
  it("preserves hosted pagination parsing and errors", async () => {
    const fixture = build("repository", true, {
      runReviewTraceSessions: async (input) => {
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
      const fixture = build("repository", false, {
        runReviewTraceAllow: async (input) => {
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
    const fixture = build("repository", false, {
      runReviewTraceGitHook: async (input) => {
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
  it("renders repository help and hides hook commands", () => {
    const fixture = build("repository", false);
    expect(fixture.parent.helpInformation()).toContain("status");
    expect(fixture.parent.helpInformation()).not.toContain("git-hook");
    expect(fixture.parent.helpInformation()).not.toContain("hook <event>");
  });
  it.each<"review" | "repository">(["review", "repository"])(
    "renders explicit hidden hook help for %s",
    async (reads) => {
      const fixture = build(reads, false);
      await expect(fixture.parse(["hook", "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(fixture.result.out).toContain(
        reads === "review"
          ? "Handle agent session lifecycle hooks"
          : "Handle dev-traces agent session lifecycle hooks",
      );
      expect(fixture.result.code).toBe(-1);
    },
  );
});
