import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { runWhiteboardCli } from "../cli-runner.js";
import { connectSessionApi } from "../review-api/agent-client.js";
import { SessionApiClient } from "../review-api/client.js";
import type { Pins } from "../review-api/document.js";
import { createSessionApi } from "../review-api/http.js";
import { serveWhiteboardMcp } from "../review-api/mcp.js";
import { openReviewProfile } from "../review-api/profile.js";
import type { Result, Snapshot } from "../review-api/store.js";
import {
  type ReviewServerDiscovery,
  readReviewServerDiscovery,
  reviewServerDiscoveryPath,
  reviewServerIsHealthy,
} from "../server-discovery.js";
import { runHeadlessServer } from "./headless-host.js";

let root: string;

const stops: (() => Promise<void>)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-headless-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function start(
  stateDir = path.join(root, "server"),
  softwareMapEnabled = false,
) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<ReviewServerDiscovery>();

  const running = runHeadlessServer({
    stateDir,
    softwareMapEnabled,
    signal: controller.signal,
    onReady: ready.resolve,
  });

  const stop = async () => {
    controller.abort();
    await running;
  };

  stops.push(stop);

  const discovery = await Promise.race([
    ready.promise,
    running.then(() => {
      throw new Error("Server exited before readiness");
    }),
  ]);

  const env = { ...process.env, DEV_REVIEW_SERVER_DIR: stateDir };

  const client = new SessionApiClient({
    serverUrl: discovery.url,
    token: discovery.token,
    apiPath: "/sessions-api",
  });

  return { client, discovery, env, stateDir, stop };
}

async function repository() {
  const directory = path.join(root, "repo");
  await mkdir(directory);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review-test@example.invalid");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    path.join(directory, "example.ts"),
    "export const value = 2;\n",
  );
  git("commit", "-qam", "head");

  return { directory, base, head: git("rev-parse", "HEAD") };
}

async function cli(argv: string[], env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  let output = "",
    errors = "";

  stdout.on("data", (chunk) => {
    output += chunk;
  });
  stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exitCode = await runWhiteboardCli({ argv, env, stdout, stderr });

  return { exitCode, output, errors };
}

it("shares review identity, resources, sessions and live changes with Desktop in one profile", async () => {
  const repo = await repository();
  const server = await start(root);
  const local = await openReviewProfile(root, { manageWorkspaces: true });
  const opened: string[] = [];

  const app = createSessionApi(
    local.store,
    local.data,
    async ({ sessionId }) => {
      opened.push(sessionId);

      return { softwareMapEnabled: false };
    },
  );

  const desktop = new SessionApiClient(
    { serverUrl: "http://desktop.test", token: "test" },
    async (url, init) => app.request(url.replace("/sessions-api", ""), init),
  );

  const abort = new AbortController();
  const catalog = desktop.watch(null, abort.signal);
  let reviewStream: ReturnType<SessionApiClient["watch"]> | undefined;

  try {
    // The scratchpad is off by default, so there is nothing to list yet.
    expect((await catalog.next()).value).toEqual([]);

    const registered = await server.client.post<{ id: string }>(
      "/repositories",
      { path: repo.directory },
    );

    const pins = {
      repositoryId: registered.id,
      base: repo.base,
      head: repo.head,
    };

    const created = await server.client.post<Result>("/commands", {
      commandId: randomUUID(),
      operation: { type: "create", title: "Shared review", pins },
    });

    const retired = await fetch(
      `${server.discovery.url}/reviews-api/commands`,
      {
        method: "POST",
        headers: {
          "x-whiteboard-token": server.discovery.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commandId: randomUUID(),
          operation: { type: "delete", sessionId: created.sessionId },
        }),
      },
    );

    expect(retired.status).toBe(410);
    expect(await retired.json()).toMatchObject({ code: "review_renamed" });
    expect(
      await server.client.read(`/${created.sessionId}?full=true`),
    ).toMatchObject({ sessionId: created.sessionId });

    // Catalog refreshes can also report repository registration before creation.
    for await (const value of catalog) {
      if (
        Array.isArray(value) &&
        value.some((item) => item.sessionId === created.sessionId)
      )
        break;
    }

    reviewStream = desktop.watch(created.sessionId, abort.signal);
    expect((await reviewStream.next()).value).toMatchObject({
      sessionId: created.sessionId,
      version: 0,
    });
    const leaseId = randomUUID();
    await server.client.post(`/${created.sessionId}/activity`, {
      action: "begin",
      leaseId,
    });

    for (;;) {
      const value = (await reviewStream.next()).value;

      if (
        value &&
        !Array.isArray(value) &&
        "activity" in value &&
        value.activity?.workingCount === 1
      )
        break;
    }

    await expect(
      desktop.post("/commands", {
        commandId: randomUUID(),
        operation: {
          type: "rename",
          sessionId: created.sessionId,
          title: "Competing author",
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const traceId = randomUUID();
    await server.client.post("/resources", {
      id: traceId,
      repositoryId: registered.id,
      kind: "trace",
      trace: {
        label: "Evidence",
        events: [{ id: "answer", role: "assistant", text: "Shared bytes" }],
      },
    });
    expect(
      await desktop.read(`/${created.sessionId}/resources/${traceId}`),
    ).toMatchObject({
      label: "Evidence",
    });
    await server.client.post("/commands", {
      commandId: randomUUID(),
      leaseId,
      operation: {
        type: "edit",
        sessionId: created.sessionId,
        edit: {
          type: "insert",
          content: {
            type: "trace_quote",
            traceId,
            eventId: "answer",
            text: "Shared bytes",
          },
        },
      },
    });

    for (;;) {
      const value = (await reviewStream.next()).value;

      if (
        value &&
        !Array.isArray(value) &&
        "version" in value &&
        value.version === 1
      )
        break;
    }

    await desktop.post(`/${created.sessionId}/open`, {});
    expect(opened).toEqual([created.sessionId]);
    expect(
      (await desktop.read<Snapshot[]>(""))
        .map((item) => item.sessionId)
        .filter((id) => id !== "scratchpad"),
    ).toEqual([created.sessionId]);
    await server.client.post(`/${created.sessionId}/activity`, {
      action: "end",
      leaseId,
    });
    await desktop.post("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "rename",
        sessionId: created.sessionId,
        title: "Changed in Desktop",
      },
    });
    expect(
      await server.client.read(`/${created.sessionId}?full=true`),
    ).toMatchObject({ title: "Changed in Desktop", version: 2 });
    await server.client.post("/commands", {
      commandId: randomUUID(),
      operation: { type: "delete", sessionId: created.sessionId },
    });
    await expect(async () => {
      for await (const _value of reviewStream!) {
      }
    }).rejects.toThrow(/not found/i);
  } finally {
    abort.abort();
    await local.data.close();
    await local.store.close();
  }
});

it("authors through CLI and MCP without Desktop and retains source, unfinished sections and resources across restart", async () => {
  const repo = await repository();
  const server = await start();
  const client = server.client;

  const registered = await client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  const pins = await client.post<Pins>("/pins", {
    repositoryId: registered.id,
    base: repo.base,
    head: repo.head,
  });

  const created = await cli(
    [
      "--state-dir",
      server.stateDir,
      "api",
      "session_create",
      JSON.stringify({
        commandId: randomUUID(),
        title: "CI review",
        pins,
      }),
    ],
    process.env,
  );

  expect(created).toMatchObject({ exitCode: 0, errors: "" });

  const { sessionId } = z
    .object({ sessionId: z.string() })
    .parse(JSON.parse(created.output));

  await client.post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      sessionId,
      edit: {
        type: "insert",
        content: {
          type: "section",
          title: "Work in progress",
          children: [],
        },
      },
    },
  });
  const imageId = randomUUID();

  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();

  await client.post("/resources", {
    id: imageId,
    repositoryId: registered.id,
    kind: "image",
    base64: image.toString("base64"),
  });
  await client.post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "edit",
      sessionId,
      edit: {
        type: "insert",
        content: {
          type: "image",
          assetId: imageId,
          alt: "Retained image",
        },
      },
    },
  });
  const traceId = randomUUID();
  await client.post("/resources", {
    id: traceId,
    repositoryId: registered.id,
    kind: "trace",
    trace: {
      label: "CI author",
      events: [{ id: "one", role: "assistant", text: "Checked the source" }],
    },
  });
  // Existing maps can be uploaded even with generation disabled.
  const mapId = randomUUID();
  await client.post("/resources", {
    id: mapId,
    repositoryId: registered.id,
    kind: "map",
    pins,
    side: "head",
    model: {
      systems: {
        app: {
          containers: {
            api: {
              components: {
                value: {
                  codeElements: {
                    value: {
                      sourceRanges: [
                        { file: "example.ts", fromLine: 1, toLine: 1 },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  await expect(
    client.post("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "edit",
        sessionId,
        edit: {
          type: "insert",
          content: {
            type: "code_peek",
            source: {
              file: "missing.ts",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 1 },
            },
          },
        },
      },
    }),
  ).rejects.toThrow(/unavailable at the pinned commit/i);
  expect(await client.read<Snapshot>(`/${sessionId}?full=true`)).toMatchObject({
    version: 2,
  });
  await server.stop();
  expect(await readReviewServerDiscovery(server.stateDir)).toBeNull();

  const restarted = await start(server.stateDir);
  expect(
    await restarted.client.read<Snapshot>(`/${sessionId}?full=true`),
  ).toMatchObject({
    sessionId,
    pins,
    document: [{ title: "Work in progress" }, { assetId: imageId }],
  });

  const retained = await restarted.client.response(
    `/${sessionId}/resources/${imageId}`,
  );

  expect(Buffer.from(await retained.arrayBuffer())).toEqual(image);
  expect(
    (await restarted.client.response(`/${sessionId}/resources/${traceId}`))
      .status,
  ).toBe(200);
  expect(
    (await restarted.client.response(`/${sessionId}/resources/${mapId}`))
      .status,
  ).toBe(200);

  const file = await restarted.client.read<{ text: string }>(
    `/${sessionId}/file?side=head&file=example.ts`,
  );

  expect(file.text).toBe("export const value = 2;\n");

  const stdin = new PassThrough(),
    stdout = new PassThrough();

  const mcp = await serveWhiteboardMcp(
    () => connectSessionApi(restarted.env),
    stdin,
    stdout,
    process.stderr,
  );

  const replies: {
    id: number;
    result: { content?: { text: string }[]; isError?: boolean };
  }[] = [];

  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += chunk;
    let end: number;

    while ((end = buffer.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });

  try {
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "CI", version: "1" },
        },
      }) + "\n",
    );
    await expect.poll(() => replies.some((reply) => reply.id === 1)).toBe(true);
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "session_get",
          arguments: { sessionId: sessionId, full: true, format: "json" },
        },
      }) + "\n",
    );
    await expect
      .poll(() => replies.find((reply) => reply.id === 2))
      .toBeTruthy();
    const result = replies.find((reply) => reply.id === 2)!.result;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content![0].text)).toMatchObject({
      sessionId: sessionId,
      version: 2,
    });
  } finally {
    await mcp.close();
  }
});

it("authenticates clients, reports capabilities and readiness without exposing the token, and diagnoses unavailable commits", async () => {
  const server = await start(undefined, true);
  expect(await reviewServerIsHealthy(server.discovery)).toBe(true);
  expect((await fetch(`${server.discovery.url}/reviews-api`)).status).toBe(401);
  expect((await fetch(`${server.discovery.url}/sessions-api`)).status).toBe(
    401,
  );

  const sessionCapabilities = await fetch(
    `${server.discovery.url}/sessions-api/capabilities`,
    {
      headers: { "x-whiteboard-token": server.discovery.token },
    },
  );

  expect(sessionCapabilities.status).toBe(200);
  expect(await sessionCapabilities.json()).toMatchObject({
    desktopAvailable: false,
    softwareMapEnabled: true,
  });
  expect(await server.client.read("/capabilities")).toMatchObject({
    desktopAvailable: false,
    softwareMapEnabled: true,
  });

  const status = await cli(
    ["--state-dir", server.stateDir, "server", "status", "--json"],
    process.env,
  );

  expect(status).toMatchObject({ exitCode: 0, errors: "" });
  expect(JSON.parse(status.output)).toMatchObject({
    event: "server.status",
    ready: true,
  });
  expect(status.output).not.toContain(server.discovery.token);
  const repo = await repository();

  const registered = await server.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  await expect(
    server.client.post("/pins", {
      repositoryId: registered.id,
      base: "unavailable",
      head: repo.head,
    }),
  ).rejects.toThrow(/Fetch the requested commits/);

  const result = await server.client.post<Result>("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "No UI",
      pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
    },
  });

  await expect(
    server.client.post(`/${result.sessionId}/open`, {}),
  ).rejects.toThrow(/desktop is not connected/);
  await server.stop();
  const stopped = await cli(["server", "status", "--json"], server.env);
  expect(stopped.exitCode).toBe(1);
  expect(JSON.parse(stopped.output)).toMatchObject({ event: "error" });
  await expect(connectSessionApi(server.env)).rejects.toThrow(
    /review server start/,
  );
});

it("rejects a second owner and keeps separate CI job stores independent", async () => {
  const first = await start();
  await expect(
    runHeadlessServer({
      stateDir: first.stateDir,
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(/already owns/);
  const second = await start(path.join(root, "second"));
  expect(second.discovery.url).not.toBe(first.discovery.url);
  expect(await second.client.read("/capabilities")).toMatchObject({
    softwareMapEnabled: false,
  });
  const repo = await repository();

  const registered = await first.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  await first.client.post("/commands", {
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "First job only",
      pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
    },
  });
  expect(await first.client.read("")).toMatchObject([
    { title: "First job only" },
  ]);
  expect(await second.client.read("")).toEqual([]);
  await first.stop();
  expect(await reviewServerIsHealthy(second.discovery)).toBe(true);
});

it("releases ownership after a port bind failure so startup can be retried", async () => {
  const first = await start();
  const stateDir = path.join(root, "retry");
  await expect(
    runHeadlessServer({
      stateDir,
      port: Number(new URL(first.discovery.url).port),
      signal: new AbortController().signal,
      onReady: () => {},
    }),
  ).rejects.toThrow(/EADDRINUSE/);
  const retried = await start(stateDir);
  expect(await reviewServerIsHealthy(retried.discovery)).toBe(true);
});

it("does not connect to another instance through stale discovery", async () => {
  const server = await start();
  const discoveryPath = reviewServerDiscoveryPath(server.stateDir);
  const original = JSON.parse(await readFile(discoveryPath, "utf8"));
  await writeFile(
    discoveryPath,
    JSON.stringify({ ...original, instanceId: randomUUID() }),
  );
  await expect(connectSessionApi(server.env)).rejects.toThrow(/not ready/);
});

it("refuses the removed batch authoring mode instead of ignoring it", async () => {
  const result = await cli(
    [
      "--state-dir",
      path.join(root, "refused"),
      "server",
      "start",
      "--authoring-mode",
      "batch",
    ],
    process.env,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.errors).toContain("--authoring-mode was removed");
});

it("authors through Whiteboard discovery and session tools without changing the saved identity", async () => {
  const repo = await repository();
  const server = await start();

  const registered = await server.client.post<{ id: string }>("/repositories", {
    path: repo.directory,
  });

  const env = {
    ...process.env,
    DEV_WHITEBOARD_SERVER_DIR: server.stateDir,
    DEV_REVIEW_SERVER_DIR: "/missing-old-server",
  };

  const created = await cli(
    [
      "api",
      "session_create",
      JSON.stringify({
        commandId: randomUUID(),
        title: "Whiteboard session",
        pins: { repositoryId: registered.id, base: repo.base, head: repo.head },
      }),
    ],
    env,
  );

  expect(created.exitCode).toBe(0);
  const { sessionId } = JSON.parse(created.output);

  const read = await cli(
    ["api", "session_get", JSON.stringify({ sessionId, full: true }), "--json"],
    env,
  );

  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.output)).toMatchObject({
    sessionId,
    title: "Whiteboard session",
  });
  expect(await server.client.read(`/${sessionId}?full=true`)).toMatchObject({
    sessionId: sessionId,
    title: "Whiteboard session",
  });

  const text = await cli(
    ["api", "session_get", JSON.stringify({ sessionId })],
    env,
  );

  expect(text.output).toContain(`Session ${sessionId}`);
  expect(text.output).not.toMatch(/^"/);
});
