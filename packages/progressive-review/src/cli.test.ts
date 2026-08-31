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
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runProgressiveReviewCli } from "./cli-runner";
import { runInstall as runInstallActual } from "./install";
import { runReviewMigration as runReviewMigrationActual } from "./migrate";
import { PostHogCaptureClient } from "./posthog-capture-client";
import { ProgressiveReviewTelemetry } from "./progressive-review-telemetry";
import { runReviewApp as runReviewAppActual } from "./review-app";
import { runReviewAppLaunch as runReviewAppLaunchActual } from "./review-app-launcher";
import {
  type StoredReview,
  listReviews as listReviewsActual,
  sealReviewCandidate as sealReviewCandidateActual,
} from "./review-home";
import { runReviewInfo as runReviewInfoActual } from "./review-info";
import { runReviewPublish as runReviewPublishActual } from "./review-publish";
import { runReviewScaffold as runReviewScaffoldActual } from "./review-scaffold";
import {
  installReviewCommand as installReviewCommandActual,
  pathShimPath,
} from "./server/cli-install";
import {
  runReviewThreadsList as runReviewThreadsListActual,
  runReviewThreadsReply as runReviewThreadsReplyActual,
  runReviewThreadsResolve as runReviewThreadsResolveActual,
} from "./threads-cli";

describe("Review CLI", () => {
  it("installs the review command with headless skills", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-cli-shim-install-"),
    );
    const discoveryDir = path.join(rootPath, ".dev", "review-desktop");
    const cliPath = path.join(rootPath, "cli.js");
    const cliRuntimePath = path.join(rootPath, "runtime");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEV_REVIEW_HOME: path.join(rootPath, ".dev"),
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
    const installReviewCommand = vi.fn<typeof installReviewCommandActual>(
      async () => ({
        shimPath: pathShimPath(),
        output: "[ok] installed review command\n",
      }),
    );

    try {
      await expect(
        runProgressiveReviewCli({
          argv: ["install", "codex"],
          env,
          stdout: outputStream(),
          stderr: outputStream(),
          runtime: { runInstall, installReviewCommand },
        }),
      ).resolves.toBe(0);

      expect(runInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: ["codex"],
          reviewCommand: pathShimPath(),
        }),
      );
      expect(installReviewCommand).toHaveBeenCalledExactlyOnceWith({
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
    const installReviewCommand = vi.fn<typeof installReviewCommandActual>();

    await expect(
      runProgressiveReviewCli({
        argv: ["install", "codex", "--no-shim"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runInstall, installReviewCommand },
      }),
    ).resolves.toBe(0);

    expect(runInstall).toHaveBeenCalledOnce();
    expect(runInstall.mock.calls[0]?.[0]).not.toHaveProperty("reviewCommand");
    expect(installReviewCommand).not.toHaveBeenCalled();
  });

  it("routes trace configuration through the shared installer", async () => {
    const runInstall = vi.fn<typeof runInstallActual>(async () => 0);

    await expect(
      runProgressiveReviewCli({
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
        runtime: { runInstall },
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
      runProgressiveReviewCli({
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
      runProgressiveReviewCli({
        argv: ["version"],
        cliVersion: "1.2.3",
        stdout,
        stderr: outputStream(),
      }),
    ).resolves.toBe(0);
    expect(output).toBe("1.2.3\n");
  });

  it("reports when a Codex Review wait reuses the active process", async () => {
    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));
    const review = {
      dir: "/tmp/reviews/99d4519f-5a72-4684-9af4-98abaa2849cc",
      review: { uuid: "99d4519f-5a72-4684-9af4-98abaa2849cc" },
    } as StoredReview;
    const runtime = {
      validateReviewWait: async () => review,
      startCodexWaitProcess: async () => ({
        pid: 123,
        reused: true,
        reviewUuid: review.review.uuid,
        threadId: "thread-1",
      }),
    };

    await expect(
      runProgressiveReviewCli({
        argv: ["wait", "--codex", "--review", review.review.uuid],
        env: { CODEX_THREAD_ID: "thread-1" },
        stdout,
        stderr: outputStream(),
        runtime,
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(output)).toMatchObject({
      event: "codex-wait",
      pid: 123,
      reused: true,
      waiting: true,
    });
  });

  it("registers app pick, info, scaffold, and publish without the removed start command", async () => {
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
    const runReviewPublish = vi.fn<typeof runReviewPublishActual>(
      async () => 0,
    );
    const runReviewScaffold = vi.fn<typeof runReviewScaffoldActual>(async () =>
      emptyScaffoldEvent(),
    );

    await runProgressiveReviewCli({
      argv: ["app", "pick", "--review", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewAppPick: runReviewApp },
    });
    await runProgressiveReviewCli({
      argv: ["info", "--review", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewInfo },
    });
    await runProgressiveReviewCli({
      argv: ["publish", "--review", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewPublish },
    });
    await runProgressiveReviewCli({
      argv: ["scaffold", "--base", "main", "--head", "feature"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewScaffold },
    });

    expect(runReviewApp).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(runReviewInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(runReviewPublish).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(runReviewScaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRef: "main",
        headRef: "feature",
      }),
    );
  });

  it.each([
    [["app", "launch"], "launched"],
    [["app"], "running"],
  ] as const)(
    "supports the app launch command and bare alias: %j",
    async (argv, state) => {
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
        runProgressiveReviewCli({
          argv: [...argv, "--json"],
          cwd: "/outside-a-repository",
          stdin: { isTTY: false } as NodeJS.ReadStream,
          stdout,
          stderr: outputStream(),
          runtime: { runReviewAppLaunch },
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(output)).toEqual({
        event: "app",
        action: "launch",
        state,
        instanceId: "desktop-1",
      });
    },
  );

  it.each([
    ["app launch", ["app", "launch"], "app.launch"],
    ["bare app", ["app"], "app.launch"],
    ["app pick", ["app", "pick", "--review", "review-uuid"], "app.pick"],
    ["app pick alias", ["app", "--review", "review-uuid"], "app.pick"],
    ["app pick equals alias", ["app", "--review=review-uuid"], "app.pick"],
  ])("tracks %s as %s", async (_label, argv, command) => {
    const captureCommandSucceeded = vi.fn<() => Promise<undefined>>(
      async () => undefined,
    );
    const telemetry = {
      createCommandRunId: vi.fn<
        ProgressiveReviewTelemetry["createCommandRunId"]
      >(() => "run-12345678"),
      captureInstallationCreated: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      captureCommandStarted: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      captureCommandBound: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      captureCommandSucceeded,
      captureCommandFailed: vi.fn<() => Promise<undefined>>(
        async () => undefined,
      ),
      shutdown: vi.fn<() => Promise<undefined>>(async () => undefined),
    } as unknown as ProgressiveReviewTelemetry;

    await expect(
      runProgressiveReviewCli({
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
    const telemetry = new ProgressiveReviewTelemetry({
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
      const running = runProgressiveReviewCli({
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
            properties: Record<string, unknown>;
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
      ProgressiveReviewTelemetry["captureCommandStarted"]
    >(async () => undefined);
    const captureCommandFailed = vi.fn<
      ProgressiveReviewTelemetry["captureCommandFailed"]
    >(async () => undefined);
    const telemetry = {
      createCommandRunId: () => "8b733d48-1172-46a7-9df0-3cc71930c25a",
      captureInstallationCreated: vi.fn<
        ProgressiveReviewTelemetry["captureInstallationCreated"]
      >(async () => undefined),
      captureCommandStarted,
      captureCommandBound: vi.fn<
        ProgressiveReviewTelemetry["captureCommandBound"]
      >(async () => undefined),
      captureCommandSucceeded: vi.fn<
        ProgressiveReviewTelemetry["captureCommandSucceeded"]
      >(async () => undefined),
      captureCommandFailed,
      shutdown: vi.fn<ProgressiveReviewTelemetry["shutdown"]>(
        async () => undefined,
      ),
    } as unknown as ProgressiveReviewTelemetry;

    await expect(
      runProgressiveReviewCli({
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

  it("binds scaffold telemetry and enriches the terminal event", async () => {
    const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";
    const captureCommandBound = vi.fn<
      ProgressiveReviewTelemetry["captureCommandBound"]
    >(async () => undefined);
    const captureCommandSucceeded = vi.fn<
      ProgressiveReviewTelemetry["captureCommandSucceeded"]
    >(async () => undefined);
    const telemetry = {
      createCommandRunId: () => "8b733d48-1172-46a7-9df0-3cc71930c25a",
      captureInstallationCreated: vi.fn<
        ProgressiveReviewTelemetry["captureInstallationCreated"]
      >(async () => undefined),
      captureCommandStarted: vi.fn<
        ProgressiveReviewTelemetry["captureCommandStarted"]
      >(async () => undefined),
      captureCommandBound,
      captureCommandSucceeded,
      captureCommandFailed: vi.fn<
        ProgressiveReviewTelemetry["captureCommandFailed"]
      >(async () => undefined),
      shutdown: vi.fn<ProgressiveReviewTelemetry["shutdown"]>(
        async () => undefined,
      ),
    } as unknown as ProgressiveReviewTelemetry;
    const runReviewScaffold = vi.fn<typeof runReviewScaffoldActual>(
      async (input) => {
        await input.onReviewBound?.(reviewUuid);
        return emptyScaffoldEvent();
      },
    );

    await expect(
      runProgressiveReviewCli({
        argv: ["scaffold"],
        stdout: outputStream(),
        stderr: outputStream(),
        telemetry,
        runtime: { runReviewScaffold },
      }),
    ).resolves.toBe(0);

    expect(captureCommandBound).toHaveBeenCalledWith({
      command: "scaffold",
      commandRunId: "8b733d48-1172-46a7-9df0-3cc71930c25a",
      reviewUuid,
    });
    expect(captureCommandSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "scaffold",
        commandRunId: "8b733d48-1172-46a7-9df0-3cc71930c25a",
        reviewUuid,
      }),
    );
  });

  it.each([
    ["pick subcommand", ["app", "pick", "--review", "review-uuid"]],
    ["compatibility alias", ["app", "--review", "review-uuid"]],
  ])("supports the app %s", async (_label, argv) => {
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
      runProgressiveReviewCli({
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

  it("accepts --json on scaffold and keeps stdout to one JSON line", async () => {
    const runReviewScaffold = vi.fn<typeof runReviewScaffoldActual>(async () =>
      emptyScaffoldEvent(),
    );
    const stdout = outputStream();
    let output = "";
    stdout.on("data", (chunk) => (output += String(chunk)));

    await expect(
      runProgressiveReviewCli({
        argv: ["scaffold", "--pr", "879", "--json"],
        stdout,
        stderr: outputStream(),
        runtime: { runReviewScaffold },
      }),
    ).resolves.toBe(0);

    const lines = output.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: "info",
      reviews: [],
      traces: {
        sessions: [],
        corpusRoot: null,
        repository: null,
        materializedSessions: [],
        unavailableSessions: [],
        events: 0,
        files: 0,
        paths: [],
      },
    });
  });

  it("rejects the removed info --new option", async () => {
    await expect(
      runProgressiveReviewCli({
        argv: ["info", "--new"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("passes scaffold update options to the runtime", async () => {
    const runReviewScaffold = vi.fn<typeof runReviewScaffoldActual>(async () =>
      emptyScaffoldEvent(),
    );

    await expect(
      runProgressiveReviewCli({
        argv: ["scaffold", "--review", "review-uuid-1"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewScaffold },
      }),
    ).resolves.toBe(0);
    expect(runReviewScaffold).toHaveBeenCalledWith(
      expect.objectContaining({ update: true, reviewUuid: "review-uuid-1" }),
    );

    await expect(
      runProgressiveReviewCli({
        argv: ["scaffold", "--update", "--head", "feature"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewScaffold },
      }),
    ).resolves.toBe(1);

    for (const argv of [
      ["scaffold", "--new", "--update"],
      ["scaffold", "--new", "--review", "review-uuid-1"],
    ]) {
      await expect(
        runProgressiveReviewCli({
          argv,
          stdout: outputStream(),
          stderr: outputStream(),
          runtime: { runReviewScaffold },
        }),
      ).resolves.toBe(1);
    }

    await expect(
      runProgressiveReviewCli({
        argv: ["scaffold", "--new"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewScaffold },
      }),
    ).resolves.toBe(0);
    expect(runReviewScaffold).toHaveBeenLastCalledWith(
      expect.objectContaining({ newReview: true }),
    );
  });

  it("accepts source selectors only on scaffold", async () => {
    await expect(
      runProgressiveReviewCli({
        argv: ["info", "--base", "main"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects the removed publish --with-map option", async () => {
    await expect(
      runProgressiveReviewCli({
        argv: ["publish", "--with-map"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("registers the threads verbs", async () => {
    const runReviewThreadsList = vi.fn<typeof runReviewThreadsListActual>(
      async () => 0,
    );
    const runReviewThreadsResolve = vi.fn<typeof runReviewThreadsResolveActual>(
      async () => 0,
    );
    const runReviewThreadsReply = vi.fn<typeof runReviewThreadsReplyActual>(
      async () => 0,
    );

    await runProgressiveReviewCli({
      argv: ["threads", "list", "--review", "review-uuid"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewThreadsList },
    });
    await runProgressiveReviewCli({
      argv: ["threads", "resolve", "thread-1"],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewThreadsResolve },
    });
    await runProgressiveReviewCli({
      argv: ["threads", "reply", "thread-1", "--body", "Done."],
      stdout: outputStream(),
      stderr: outputStream(),
      runtime: { runReviewThreadsReply },
    });

    expect(runReviewThreadsList).toHaveBeenCalledWith(
      expect.objectContaining({ reviewUuid: "review-uuid" }),
    );
    expect(runReviewThreadsResolve).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    );
    expect(runReviewThreadsReply).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        body: "Done.",
        author: "Agent",
      }),
    );
  });

  it("rejects the removed tools ensure command", async () => {
    await expect(
      runProgressiveReviewCli({
        argv: ["tools", "ensure"],
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("rejects the removed start command", async () => {
    await expect(
      runProgressiveReviewCli({
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
      runProgressiveReviewCli({
        argv: ["migrate", "apply"],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { runReviewMigration },
      }),
    ).resolves.toBe(0);
    await expect(
      runProgressiveReviewCli({
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
  ])("rejects removed command surface: %s", async (...argv) => {
    await expect(
      runProgressiveReviewCli({
        argv,
        stdout: outputStream(),
        stderr: outputStream(),
      }),
    ).resolves.toBe(1);
  });

  it("checkpoints every touched UUID review at the end of a turn", async () => {
    const review = {
      dir: "/tmp/reviews/review-uuid",
      review: {
        uuid: "11111111-1111-4111-8111-111111111111",
        status: "awaiting-agent-updates",
      },
    } as StoredReview;
    const listReviews = vi.fn<typeof listReviewsActual>(async () => ({
      reviews: [review],
      errors: [],
    }));
    const sealReviewCandidate = vi.fn<typeof sealReviewCandidateActual>(
      async () => "revision",
    );
    const stdin = new PassThrough();
    stdin.end(`${JSON.stringify({ cwd: `${review.dir}/notes` })}\n`);

    await expect(
      runProgressiveReviewCli({
        argv: ["stop-hook"],
        stdin,
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { listReviews, sealReviewCandidate },
      }),
    ).resolves.toBe(0);

    expect(listReviews).toHaveBeenCalledWith();
    expect(sealReviewCandidate).toHaveBeenCalledWith(
      review.dir,
      "Review turn checkpoint",
    );
  });

  it("handles the internal prepare-worktree command", async () => {
    const prepareReviewPinnedCheckout = vi.fn<
      () => Promise<{ prepared: true }>
    >(async () => ({ prepared: true }));

    await expect(
      runProgressiveReviewCli({
        argv: [
          "prepare-worktree",
          "/tmp/test-checkout",
          "--commit",
          "0123456789abcdef0123456789abcdef01234567",
        ],
        stdout: outputStream(),
        stderr: outputStream(),
        runtime: { prepareReviewPinnedCheckout },
      }),
    ).resolves.toBe(0);

    expect(prepareReviewPinnedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutPath: expect.stringContaining("test-checkout"),
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    );
  });
});

function emptyScaffoldEvent(): Awaited<
  ReturnType<typeof runReviewScaffoldActual>
> {
  return {
    event: "info",
    reviews: [],
    traces: {
      sessions: [],
      corpusRoot: null,
      repository: null,
      materializedSessions: [],
      unavailableSessions: [],
      events: 0,
      files: 0,
      paths: [],
    },
  };
}

function outputStream(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}
