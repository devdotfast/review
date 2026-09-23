import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import {
  StoreClient,
  runTraceSessions as runTraceSessionsActual,
} from "@dev.fast/trace-core";
import { describe, expect, it, vi } from "vitest";

import {
  installWhiteboardCommand as installWhiteboardCommandActual,
  pathShimPath,
} from "./cli-install";
import { runWhiteboardCli } from "./cli-runner";
import { runInstall as runInstallActual } from "./install";
import { runWhiteboardMigration as runWhiteboardMigrationActual } from "./migrate";
import {
  PostHogCaptureClient,
  type PostHogCaptureProperties,
} from "./posthog-capture-client";
import {
  runTracePull as runTracePullActual,
  runTraceStatus as runTraceStatusActual,
} from "./trace-cli";
import { runWhiteboardAppPick as runWhiteboardAppActual } from "./whiteboard-app";
import { runWhiteboardAppLaunch as runWhiteboardAppLaunchActual } from "./whiteboard-app-launcher";
import { runWhiteboardInfo as runWhiteboardInfoActual } from "./whiteboard-info";
import {
  type WhiteboardCommandTelemetry,
  WhiteboardTelemetry,
} from "./whiteboard-telemetry";

describe("Review CLI", () => {
  it.each([[], ["codex"]])(
    "installs skills and PATH without agent executables: %j",
    async (...targets) => {
      const homeDir = await mkdtemp(
        path.join(os.tmpdir(), "review-no-agents-"),
      );

      const cliPath = path.join(homeDir, "whiteboard-cli.js");
      const discoveryDir = path.join(homeDir, ".dev", "review-desktop");

      const env = {
        HOME: homeDir,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
      };

      try {
        await mkdir(discoveryDir, { recursive: true });
        await writeFile(cliPath, "// fixture CLI\n");
        await writeFile(
          path.join(discoveryDir, "server.json"),
          JSON.stringify({
            version: 3,
            instanceId: "test-instance",
            url: "http://127.0.0.1:43819",
            appPid: 100,
            serverPid: 101,
            token: "test-token",
            startedAt: 1,
            cliPath,
            cliRuntimePath: process.execPath,
          }),
        );
        const stderr = outputStream();

        const code = await runWhiteboardCli({
          argv: ["install", ...targets],
          cwd: homeDir,
          env,
          stdout: outputStream(),
          stderr,
          runtime: {
            runInstall: (input) =>
              runInstallActual({ ...input, homeDir, cwd: homeDir }),
            installWhiteboardCommand: (input) =>
              installWhiteboardCommandActual({ ...input, homeDir }),
          },
        });

        expect(code).toBe(0);
        expect(
          await readFile(
            path.join(homeDir, ".agents/skills/dev-review/SKILL.md"),
            "utf8",
          ),
        ).toContain("dev-review");
        expect(await readFile(pathShimPath(homeDir), "utf8")).toContain(
          cliPath,
        );
        expect(
          await readFile(path.join(homeDir, ".zprofile"), "utf8"),
        ).toContain(".local/bin");
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("routes own-upload status filters without requesting trace content", async () => {
    const runTraceStatus = vi.fn<typeof runTraceStatusActual>(async () => 0);

    const code = await runWhiteboardCli({
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

  it("installs the review command with headless skills", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-cli-shim-install-"),
    );

    const discoveryDir = path.join(rootPath, ".dev", "review-desktop");
    const cliPath = path.join(rootPath, "whiteboard-cli.js");
    const cliRuntimePath = path.join(rootPath, "runtime");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEV_WHITEBOARD_HOME: path.join(rootPath, ".dev"),
    };

    await mkdir(discoveryDir, { recursive: true });
    await Promise.all([
      writeFile(cliPath, "// test CLI\n"),
      writeFile(
        path.join(discoveryDir, "server.json"),
        `${JSON.stringify({
          version: 3,
          instanceId: "test-instance",
          url: "http://127.0.0.1:43819",
          appPid: 100,
          serverPid: 101,
          token: "test-token",
          startedAt: 1,
          cliPath,
          cliRuntimePath,
        })}\n`,
      ),
    ]);
    const runInstall = vi.fn<typeof runInstallActual>(async () => 0);

    const installWhiteboardCommand = vi.fn<
      typeof installWhiteboardCommandActual
    >(async () => ({
      shimPath: pathShimPath(),
      output: "[ok] installed review command\n",
    }));

    try {
      await expect(
        runWhiteboardCli({
          argv: ["install", "codex"],
          env,
          stdout: outputStream(),
          stderr: outputStream(),
          runtime: { runInstall, installWhiteboardCommand },
        }),
      ).resolves.toBe(0);

      expect(runInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: ["codex"],
          whiteboardCommand: pathShimPath(),
        }),
      );
      expect(installWhiteboardCommand).toHaveBeenCalledExactlyOnceWith({
        cliPath,
        cliRuntimePath,
        env,
      });
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it("supports a headless shim opt-out", async () => {
    const runInstall = vi.fn<typeof runInstallActual>(async () => 0);

    const installWhiteboardCommand =
      vi.fn<typeof installWhiteboardCommandActual>();

    await expect(
      runWhiteboardCli({
        argv: ["install", "codex", "--no-shim"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runInstall, installWhiteboardCommand },
      }),
    ).resolves.toBe(0);

    expect(runInstall).toHaveBeenCalledOnce();
    expect(runInstall.mock.calls[0]?.[0]).not.toHaveProperty(
      "whiteboardCommand",
    );
    expect(installWhiteboardCommand).not.toHaveBeenCalled();
  });

  it("routes trace configuration through the shared installer", async () => {
    const runInstall = vi.fn<typeof runInstallActual>(async () => 0);

    // install also writes the review command; a stub keeps it out of $HOME.
    const installWhiteboardCommand = vi.fn<
      typeof installWhiteboardCommandActual
    >(async () => ({ shimPath: "", output: "" }));

    await expect(
      runWhiteboardCli({
        argv: [
          "install",
          "codex",
          "--trace-endpoint",
          "mock://endpoint",
          "--trace-bucket",
          "mock-bucket",
          "--trace-key",
          "mock-key",
          "--trace-secret",
          "mock-value",
        ],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runInstall, installWhiteboardCommand },
      }),
    ).resolves.toBe(0);

    expect(runInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: ["codex"],
        fff: true,
        trace: {
          credentials: {
            endpoint: "mock://endpoint",
            bucket: "mock-bucket",
            key: "mock-key",
            secret: "mock-value",
          },
        },
      }),
    );
  });

  it("does not expose the removed trace setup command", async () => {
    const stderr = outputStream();
    let output = "";
    stderr.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runWhiteboardCli({
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
      runWhiteboardCli({
        argv: ["version"],
        cliVersion: "1.2.3",
        stdout,
        stderr: outputStream(),
      }),
    ).resolves.toBe(0);
    expect(output).toBe("1.2.3\n");
  });

  it("registers app pick and info", async () => {
    const runWhiteboardApp = vi.fn<typeof runWhiteboardAppActual>(async () => ({
      event: "app" as const,
      action: "pick" as const,
      sessionId: "review-uuid",
      title: "Review",
    }));

    const runWhiteboardInfo = vi.fn<typeof runWhiteboardInfoActual>(
      async () => ({
        event: "info" as const,
        sessions: [],
      }),
    );

    await runWhiteboardCli({
      argv: ["app", "pick", "--session", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runWhiteboardAppPick: runWhiteboardApp },
    });
    await runWhiteboardCli({
      argv: ["info", "--session", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runWhiteboardInfo },
    });

    expect(runWhiteboardApp).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "review-uuid" }),
    );
    expect(runWhiteboardInfo).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "review-uuid" }),
    );
  });

  it.each([
    [["app", "launch"], "launched", undefined],
    [["app"], "running", undefined],
    [["app", "launch", "--focus"], "running", true],
    [["app", "--focus"], "launched", true],
  ] as const)(
    "supports the app launch command and bare alias: %j",
    async (argv, state, focus) => {
      const runWhiteboardAppLaunch = vi.fn<typeof runWhiteboardAppLaunchActual>(
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
        runWhiteboardCli({
          argv: [...argv, "--json"],
          cwd: "/outside-a-repository",
          stdin: Readable.from([]),
          stdout,
          stderr: outputStream(),
          runtime: { runWhiteboardAppLaunch },
        }),
      ).resolves.toBe(0);
      expect(runWhiteboardAppLaunch).toHaveBeenCalledWith({ focus });
      expect(JSON.parse(output)).toEqual({
        event: "app",
        action: "launch",
        state,
        instanceId: "desktop-1",
      });
    },
  );

  it("passes --focus through app pick", async () => {
    const runWhiteboardAppPick = vi.fn<typeof runWhiteboardAppActual>(
      async () => ({
        event: "app",
        action: "pick",
        sessionId: "review-uuid",
        title: "Picked",
      }),
    );

    await expect(
      runWhiteboardCli({
        argv: ["app", "pick", "--session", "review-uuid", "--focus", "--json"],
        cwd: "/outside-a-repository",
        stdin: Readable.from([]),
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runWhiteboardAppPick },
      }),
    ).resolves.toBe(0);
    expect(runWhiteboardAppPick).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "review-uuid", focus: true }),
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
      createCommandRunId: vi.fn<WhiteboardTelemetry["createCommandRunId"]>(
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
    } satisfies WhiteboardCommandTelemetry;

    await expect(
      runWhiteboardCli({
        argv,
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: {
          runWhiteboardAppLaunch: async () => ({
            event: "app",
            action: "launch",
            state: "running",
            instanceId: "desktop-1",
          }),
          runWhiteboardAppPick: async () => ({
            event: "app",
            action: "pick",
            sessionId: "review-uuid",
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

    const telemetry = new WhiteboardTelemetry({
      captureClient,
      env: {},
      installConfigPath: path.join(rootPath, "telemetry.json"),
      idFactory: () => "install-123",
      randomUUID: () => "8b733d48-1172-46a7-9df0-3cc71930c25a",
    });

    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => (entered = resolve));

    let release!: (
      value: Awaited<ReturnType<typeof runWhiteboardInfoActual>>,
    ) => void;

    const handlerResult = new Promise<
      Awaited<ReturnType<typeof runWhiteboardInfoActual>>
    >((resolve) => (release = resolve));

    const runWhiteboardInfo = vi.fn<typeof runWhiteboardInfoActual>(
      async () => {
        entered();

        return handlerResult;
      },
    );

    try {
      const running = runWhiteboardCli({
        argv: ["info"],
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: { runWhiteboardInfo },
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

      release({ event: "info", sessions: [] });
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
      WhiteboardTelemetry["captureCommandStarted"]
    >(async () => undefined);

    const captureCommandFailed = vi.fn<
      WhiteboardTelemetry["captureCommandFailed"]
    >(async () => undefined);

    const telemetry = {
      createCommandRunId: () => "8b733d48-1172-46a7-9df0-3cc71930c25a",
      captureInstallationCreated: vi.fn<
        WhiteboardTelemetry["captureInstallationCreated"]
      >(async () => undefined),
      captureCommandStarted,
      captureCommandSucceeded: vi.fn<
        WhiteboardTelemetry["captureCommandSucceeded"]
      >(async () => undefined),
      captureCommandFailed,
      shutdown: vi.fn<WhiteboardTelemetry["shutdown"]>(async () => undefined),
    } satisfies WhiteboardCommandTelemetry;

    await expect(
      runWhiteboardCli({
        argv: ["info"],
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: {
          runWhiteboardInfo: async () => {
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

    const runWhiteboardAppPick = vi.fn<typeof runWhiteboardAppActual>(
      async () => ({
        event: "app",
        action: "pick",
        sessionId: "review-uuid",
        title: "Review",
      }),
    );

    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runWhiteboardCli({
        argv: [...argv, "--json"],
        stdout,
        stderr: outputStream(),
        runtime: { runWhiteboardAppPick },
      }),
    ).resolves.toBe(0);
    expect(runWhiteboardAppPick).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "review-uuid" }),
    );
    expect(JSON.parse(output)).toMatchObject({
      event: "app",
      action: "pick",
      sessionId: "review-uuid",
    });
  });

  it("rejects an invalid --view for app pick", async () => {
    await expect(
      runWhiteboardCli({
        argv: ["app", "pick", "--session", "review-uuid", "--view", "files"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects the removed info --new option", async () => {
    await expect(
      runWhiteboardCli({
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
        runWhiteboardCli({
          argv: ["trace", "sessions", "--limit", value],
          stdout: outputStream(),
          stderr,
          runtime: { runTraceSessions },
        }),
      ).resolves.toBe(1);
      expect(runTraceSessions).not.toHaveBeenCalled();
    }

    await expect(
      runWhiteboardCli({
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
      runWhiteboardCli({
        argv: ["tools", "ensure"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects the removed start command", async () => {
    await expect(
      runWhiteboardCli({
        argv: ["start"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("accepts only migrate apply and migrate apply --force", async () => {
    const runWhiteboardMigration = vi.fn<typeof runWhiteboardMigrationActual>(
      async () => 0,
    );

    await expect(
      runWhiteboardCli({
        argv: ["migrate", "apply"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runWhiteboardMigration },
      }),
    ).resolves.toBe(0);
    await expect(
      runWhiteboardCli({
        argv: ["migrate", "apply", "--force"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runWhiteboardMigration },
      }),
    ).resolves.toBe(0);

    expect(runWhiteboardMigration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ force: undefined }),
    );
    expect(runWhiteboardMigration).toHaveBeenNthCalledWith(
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
      runWhiteboardCli({
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

  const code = await runWhiteboardCli({
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
      remedy: "whiteboard login --traces",
    },
  });
});

it("keeps Whiteboard sessions and agent conversations distinct with a single command interface", async () => {
  const runTracePull = vi.fn<typeof runTracePullActual>(async () => 0);
  const runTraceStatus = vi.fn<typeof runTraceStatusActual>(async () => 0);

  const runWhiteboardInfo = vi.fn<typeof runWhiteboardInfoActual>(async () => ({
    event: "info",
    sessions: [],
  }));

  const invoke = (argv: string[]) =>
    runWhiteboardCli({
      argv,
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runTracePull, runTraceStatus, runWhiteboardInfo },
    });

  expect(await invoke(["trace", "pull", "--session", "board"])).toBe(0);
  expect(runTracePull).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: "board", session: undefined }),
  );
  expect(await invoke(["trace", "pull", "--agent-session", "agent"])).toBe(0);
  expect(runTracePull).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: undefined, session: "agent" }),
  );
  expect(
    await invoke([
      "trace",
      "pull",
      "--session",
      "board",
      "--agent-session",
      "agent",
    ]),
  ).toBe(1);
  expect(runTracePull).toHaveBeenCalledTimes(2);
  expect(await invoke(["trace", "status", "--agent-session", "agent"])).toBe(0);
  expect(runTraceStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: "agent" }),
  );
  expect(await invoke(["info", "--session", "board"])).toBe(0);
  expect(runWhiteboardInfo).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: "board" }),
  );
});

it("uses session identifiers in Whiteboard discovery and picker output", async () => {
  const summary = {
    sessionId: "saved-id",
    version: 4,
    title: "Review my sessionId field",
    viewedAt: null,
    dismissedAt: null,
    pins: { repositoryId: "repo", base: "base", head: "head" },
    createdAt: "2026-09-21T00:00:00Z",
    repositoryName: "repo",
  };

  const runWhiteboardInfo = vi.fn<typeof runWhiteboardInfoActual>(async () => ({
    event: "info",
    sessions: [summary],
  }));

  const runWhiteboardAppPick = vi.fn<typeof runWhiteboardAppActual>(
    async () => ({
      event: "app",
      action: "pick",
      sessionId: summary.sessionId,
      title: summary.title,
    }),
  );

  for (const argv of [
    ["info", "--session", "saved-id"],
    ["app", "pick", "--session", "saved-id", "--json"],
  ]) {
    let output = "";

    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk;
        callback();
      },
    });

    expect(
      await runWhiteboardCli({
        argv,
        stdout,
        stderr: outputStream(),
        runtime: { runWhiteboardInfo, runWhiteboardAppPick },
      }),
    ).toBe(0);
    const result = JSON.parse(output);
    const session = result.sessions?.[0] ?? result;
    expect(session).toMatchObject({
      sessionId: "saved-id",
      title: summary.title,
    });
    expect(session).not.toHaveProperty("reviewId");
    expect(session).not.toHaveProperty("whiteboardUuid");
  }
});
