import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import {
  StoreClient,
  runTraceSessions as runTraceSessionsActual,
} from "@dev.fast/trace-core";
import { describe, expect, it, vi } from "vitest";

import { runReviewCli } from "./cli-runner";
import { runReviewMigration as runReviewMigrationActual } from "./migrate";
import {
  PostHogCaptureClient,
  type PostHogCaptureProperties,
} from "./posthog-capture-client";
import { runReviewAppPick as runReviewAppActual } from "./review-app";
import { runReviewAppLaunch as runReviewAppLaunchActual } from "./review-app-launcher";
import { runReviewInfo as runReviewInfoActual } from "./review-info";
import {
  type ReviewCommandTelemetry,
  ReviewTelemetry,
} from "./review-telemetry";
import { runTraceStatus as runTraceStatusActual } from "./trace-cli";

describe("Whiteboard CLI", () => {
  it("routes Cursor install instructions without connecting to Desktop", async () => {
    const { code, stdout, stderr } = await runConnect([
      "mcp",
      "install-instructions",
      "--harness",
      "cursor",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result.harness).toBe("cursor");
    const link = new URL(result.instructions.match(/cursor:\/\/\S+/)[0]);
    expect(link.hostname).toBe("anysphere.cursor-deeplink");
    expect(
      JSON.parse(
        Buffer.from(link.searchParams.get("config")!, "base64").toString(),
      ),
    ).toEqual({
      command: "sh",
      args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
    });
  });

  it.each([
    [],
    ["--harness", "unknown"],
    ["--harness", "cursor", "--unknown"],
    ["--harness", "cursor", "extra"],
  ])("rejects invalid install-instructions arguments %j", async (...args) => {
    const result = await runConnect(["mcp", "install-instructions", ...args]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("prints every prompt with headings by default", async () => {
    const { code, stdout } = await runConnect(["connect"]);

    expect(code).toBe(0);
    expect(stdout).toContain("## Claude Code");
    expect(stdout).toContain("## Pi");
  });

  it("emits the selected prompts as one JSON event", async () => {
    const { code, stdout } = await runConnect([
      "connect",
      "claude-code",
      "--json",
    ]);

    const event = JSON.parse(stdout);

    expect(code).toBe(0);
    expect(event.event).toBe("connect");
    expect(Object.keys(event.prompts)).toEqual(["claude"]);
  });

  it("routes own-upload status filters without requesting trace content", async () => {
    const runTraceStatus = vi.fn<typeof runTraceStatusActual>(async () => 0);

    const code = await runReviewCli({
      argv: [
        "trace",
        "status",
        "--agent-session",
        "my-upload-session",
        "--limit",
        "5",
        "--cursor",
        "cursor-value",
      ],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runTraceStatus },
    });

    expect(code).toBe(0);
    expect(runTraceStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "my-upload-session",
        limit: 5,
        cursor: "cursor-value",
      }),
    );
  });

  it("does not expose the removed trace setup command", async () => {
    const stderr = outputStream();
    let output = "";
    stderr.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewCli({
        argv: ["trace", "setup"],
        stdout: outputStream(),
        stderr,
      }),
    ).resolves.toBe(1);
    expect(output).toContain("unknown command 'setup'");
  });

  it("prints the package version", async () => {
    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewCli({
        argv: ["version"],
        cliVersion: "1.2.3",
        stdout,
        stderr: outputStream(),
      }),
    ).resolves.toBe(0);
    expect(output).toBe("1.2.3\n");
  });

  it("registers app pick and info", async () => {
    const runReviewApp = vi.fn<typeof runReviewAppActual>(async () => ({
      event: "app" as const,
      action: "pick" as const,
      reviewUuid: "review-uuid",
      title: "Review",
    }));

    const runReviewInfo = vi.fn<typeof runReviewInfoActual>(async () => ({
      event: "info" as const,
      reviews: [],
    }));

    await runReviewCli({
      argv: ["app", "pick", "--session", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewAppPick: runReviewApp },
    });
    await runReviewCli({
      argv: ["info", "--session", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewInfo },
    });

    expect(runReviewApp).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(runReviewInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
  });

  // The JSON authoring verbs are the only remaining surface no other case
  // drives; both print the agent CLI help without contacting the Desktop.
  it.each([["api"], ["mcp", "--help"]])(
    "registers the JSON authoring verb %j",
    async (...argv) => {
      const stdout = outputStream();
      let output = "";
      stdout.on("data", (chunk) => (output += String(chunk)));

      await expect(
        runReviewCli({
          argv,
          stdout,
          stderr: outputStream(),
        }),
      ).resolves.toBe(0);
      expect(output).toContain("whiteboard api tools");
    },
  );

  it.each([
    [["app", "launch"], "launched", undefined],
    [["app"], "running", undefined],
    [["app", "launch", "--focus"], "running", true],
    [["app", "--focus"], "launched", true],
  ] as const)(
    "supports the app launch command and bare alias: %j",
    async (argv, state, focus) => {
      const runReviewAppLaunch = vi.fn<typeof runReviewAppLaunchActual>(
        async () => ({
          event: "app",
          action: "launch",
          state,
          instanceId: "desktop-1",
        }),
      );

      const stdout = outputStream();
      let output = "";
      stdout.on("data", (chunk) => (output += String(chunk)));

      await expect(
        runReviewCli({
          argv: [...argv, "--json"],
          cwd: "/outside-a-repository",
          stdin: Readable.from([]),
          stdout,
          stderr: outputStream(),
          runtime: { runReviewAppLaunch },
        }),
      ).resolves.toBe(0);
      expect(runReviewAppLaunch).toHaveBeenCalledWith({ focus });
      expect(JSON.parse(output)).toEqual({
        event: "app",
        action: "launch",
        state,
        instanceId: "desktop-1",
      });
    },
  );

  it.each([
    [
      [],
      "Whiteboard Desktop is ready in the background. Pass --focus to bring it forward.",
    ],
    [["--focus"], "Whiteboard Desktop is ready."],
  ] as const)(
    "describes a fresh launch according to the flag: %j",
    async (flags, line) => {
      const runReviewAppLaunch = vi.fn<typeof runReviewAppLaunchActual>(
        async () => ({
          event: "app",
          action: "launch",
          state: "launched",
          instanceId: "desktop-1",
        }),
      );

      const stdout = outputStream();
      let output = "";
      stdout.on("data", (chunk) => (output += String(chunk)));

      await expect(
        runReviewCli({
          argv: ["app", "launch", ...flags],
          cwd: "/outside-a-repository",
          stdin: Readable.from([]),
          stdout,
          stderr: outputStream(),
          runtime: { runReviewAppLaunch },
        }),
      ).resolves.toBe(0);
      expect(output).toBe(`${line}\n`);
    },
  );

  it("passes --focus through app pick", async () => {
    const runReviewAppPick = vi.fn<typeof runReviewAppActual>(async () => ({
      event: "app",
      action: "pick",
      reviewUuid: "review-uuid",
      title: "Picked",
    }));

    await expect(
      runReviewCli({
        argv: ["app", "pick", "--session", "review-uuid", "--focus", "--json"],
        cwd: "/outside-a-repository",
        stdin: Readable.from([]),
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewAppPick },
      }),
    ).resolves.toBe(0);
    expect(runReviewAppPick).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid", focus: true }),
    );
  });

  it.each([
    ["app launch", ["app", "launch"], "app.launch"],
    ["bare app", ["app"], "app.launch"],
    ["app pick", ["app", "pick", "--session", "review-uuid"], "app.pick"],
  ])("tracks %s as %s", async (_label, argv, command) => {
    const captureCommandSucceeded = vi.fn<() => Promise<undefined>>(
      async () => undefined,
    );

    const telemetry = {
      createCommandRunId: vi.fn<ReviewTelemetry["createCommandRunId"]>(
        () => "run-12345678",
      ),
      captureInstallationCreated: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      captureCommandStarted: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      captureCommandSucceeded,
      captureCommandFailed: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      shutdown: vi.fn<() => Promise<undefined>>(async () => undefined),
    } satisfies ReviewCommandTelemetry;

    await expect(
      runReviewCli({
        argv,
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: {
          runReviewAppLaunch: async () => ({
            event: "app",
            action: "launch",
            state: "running",
            instanceId: "desktop-1",
          }),
          runReviewAppPick: async () => ({
            event: "app",
            action: "pick",
            reviewUuid: "review-uuid",
            title: "Review",
          }),
        },
      }),
    ).resolves.toBe(0);
    expect(captureCommandSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ command }),
    );
  });

  it("persists command start before an unresolved handler and completes the same run", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "review-cli-run-"));

    const queueDir = path.join(rootPath, "queue");
    let queueId = 0;

    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );

    const captureClient = new PostHogCaptureClient({
      apiKey: "test-key",
      fetch: fetchMock,
      queueDir,
      idFactory: () => `queue-${queueId++}`,
    });

    const telemetry = new ReviewTelemetry({
      captureClient,
      env: {},
      installConfigPath: path.join(rootPath, "telemetry.json"),
      idFactory: () => "install-123",
      randomUUID: () => "8b733d48-1172-46a7-9df0-3cc71930c25a",
    });

    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => (entered = resolve));

    let release!: (
      value: Awaited<ReturnType<typeof runReviewInfoActual>>,
    ) => void;

    const handlerResult = new Promise<
      Awaited<ReturnType<typeof runReviewInfoActual>>
    >((resolve) => (release = resolve));

    const runReviewInfo = vi.fn<typeof runReviewInfoActual>(async () => {
      entered();

      return handlerResult;
    });

    try {
      const running = runReviewCli({
        argv: ["info"],
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: { runReviewInfo },
      });

      await handlerEntered;

      const queued = await Promise.all(
        (await readdir(queueDir))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) =>
            JSON.parse(await readFile(path.join(queueDir, file), "utf8")),
          ),
      );

      expect(queued).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "review_command_started",
            properties: expect.objectContaining({
              command_path: "info",
              command_run_id: "8b733d48-1172-46a7-9df0-3cc71930c25a",
            }),
          }),
        ]),
      );

      release({ event: "info", reviews: [] });
      await expect(running).resolves.toBe(0);

      const sent = fetchMock.mock.calls.flatMap(
        ([, init]) =>
          JSON.parse(String(init?.body)).batch as Array<{
            event: string;
            properties: PostHogCaptureProperties;
          }>,
      );

      const lifecycle = sent.filter((event) =>
        ["review_command_started", "review_command_succeeded"].includes(
          event.event,
        ),
      );

      expect(lifecycle).toHaveLength(2);
      expect(lifecycle.map((event) => event.properties.command_run_id)).toEqual(
        [
          "8b733d48-1172-46a7-9df0-3cc71930c25a",
          "8b733d48-1172-46a7-9df0-3cc71930c25a",
        ],
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("emits a failed terminal event when a handler rejects", async () => {
    const captureCommandStarted = vi.fn<
      ReviewTelemetry["captureCommandStarted"]
    >(async () => undefined);

    const captureCommandFailed = vi.fn<ReviewTelemetry["captureCommandFailed"]>(
      async () => undefined,
    );

    const telemetry = {
      createCommandRunId: () => "8b733d48-1172-46a7-9df0-3cc71930c25a",
      captureInstallationCreated: vi.fn<
        ReviewTelemetry["captureInstallationCreated"]
      >(async () => undefined),
      captureCommandStarted,
      captureCommandSucceeded: vi.fn<
        ReviewTelemetry["captureCommandSucceeded"]
      >(async () => undefined),
      captureCommandFailed,
      shutdown: vi.fn<ReviewTelemetry["shutdown"]>(async () => undefined),
    } satisfies ReviewCommandTelemetry;

    await expect(
      runReviewCli({
        argv: ["info"],
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: {
          runReviewInfo: async () => {
            throw new Error("controlled failure");
          },
        },
      }),
    ).resolves.toBe(1);

    expect(captureCommandStarted).toHaveBeenCalledWith({
      command: "info",
      commandRunId: "8b733d48-1172-46a7-9df0-3cc71930c25a",
    });
    expect(captureCommandFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "info",
        commandRunId: "8b733d48-1172-46a7-9df0-3cc71930c25a",
        exitCode: 1,
      }),
    );
  });

  it("supports the app pick subcommand", async () => {
    const argv = ["app", "pick", "--session", "review-uuid"];

    const runReviewAppPick = vi.fn<typeof runReviewAppActual>(async () => ({
      event: "app",
      action: "pick",
      reviewUuid: "review-uuid",
      title: "Review",
    }));

    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runReviewCli({
        argv: [...argv, "--json"],
        stdout,
        stderr: outputStream(),
        runtime: { runReviewAppPick },
      }),
    ).resolves.toBe(0);
    expect(runReviewAppPick).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(JSON.parse(output)).toMatchObject({
      event: "app",
      action: "pick",
      reviewUuid: "review-uuid",
    });
  });

  it("rejects an invalid --view for app pick", async () => {
    await expect(
      runReviewCli({
        argv: ["app", "pick", "--session", "review-uuid", "--view", "files"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects the removed info --new option", async () => {
    await expect(
      runReviewCli({
        argv: ["info", "--new"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects a --limit that is not a whole number before the runtime runs", async () => {
    const runTraceSessions = vi.fn<typeof runTraceSessionsActual>(
      async () => 0,
    );

    for (const value of ["50junk", "1.5", "-1", ""]) {
      const stderr = outputStream();
      await expect(
        runReviewCli({
          argv: ["trace", "sessions", "--limit", value],
          stdout: outputStream(),
          stderr,
          runtime: { runTraceSessions },
        }),
      ).resolves.toBe(1);
      expect(runTraceSessions).not.toHaveBeenCalled();
    }

    await expect(
      runReviewCli({
        argv: ["trace", "sessions", "--limit", "50"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runTraceSessions },
      }),
    ).resolves.toBe(0);
    expect(runTraceSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("rejects the removed tools ensure command", async () => {
    await expect(
      runReviewCli({
        argv: ["tools", "ensure"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects the removed start command", async () => {
    await expect(
      runReviewCli({
        argv: ["start"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("accepts only migrate apply and migrate apply --force", async () => {
    const runReviewMigration = vi.fn<typeof runReviewMigrationActual>(
      async () => 0,
    );

    await expect(
      runReviewCli({
        argv: ["migrate", "apply"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewMigration },
      }),
    ).resolves.toBe(0);
    await expect(
      runReviewCli({
        argv: ["migrate", "apply", "--force"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewMigration },
      }),
    ).resolves.toBe(0);

    expect(runReviewMigration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ force: undefined }),
    );
    expect(runReviewMigration).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ force: true }),
    );
  });

  it.each([
    ["update"],
    ["update", "--post-install", "1.2.3"],
    ["migrate", "plan"],
    ["migrate", "verify"],
    ["migrate", "cleanup"],
    ["scaffold"],
    ["publish"],
    ["present"],
    ["repair", "--session", "11111111-1111-4111-8111-111111111111"],
    ["rebind", "feature"],
    ["internal-test"],
    ["prepare-worktree", "/tmp/checkout", "--commit", "a".repeat(40)],
  ])("rejects removed command surface: %s", async (...argv) => {
    await expect(
      runReviewCli({
        argv,
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });
});

function outputStream(): PassThrough {
  return new PassThrough();
}

async function runConnect(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "review-connect-"));

  const stdout = outputStream();
  const stderr = outputStream();

  let stdoutText = "";
  let stderrText = "";

  stdout.on("data", (chunk) => (stdoutText += String(chunk)));
  stderr.on("data", (chunk) => (stderrText += String(chunk)));

  try {
    const code = await runReviewCli({
      argv,
      cwd: homeDir,
      env: {
        HOME: homeDir,
        TRACE_HOME_DIR: homeDir,
        DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
      },
      stdout,
      stderr,
    });

    return { code, stdout: stdoutText, stderr: stderrText };
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

it("emits one JSON error when a trace command needs repository authorization", async () => {
  const stdout = outputStream();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const client = new StoreClient({
    origin: "https://app.dev.fast",
    token: "identity",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "repository_authorization_required",
            message: "Run review login --traces.",
          },
        },
        { status: 403 },
      ),
  });

  const code = await runReviewCli({
    argv: ["--json", "trace", "status"],
    stdout,
    stderr: outputStream(),
    runtime: {
      runTraceStatus: async () => {
        await client.findStore({ owner: "fixture", name: "repo" });

        return 0;
      },
    },
  });

  expect(code).toBe(1);

  const events = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "error",
    error: {
      message: "Run review login --traces.",
      code: "repository_authorization_required",
      remedy: "review login --traces",
    },
  });
});
