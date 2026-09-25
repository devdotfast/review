import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import type { JsonObject } from "@dev.fast/json";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { runReviewAgentCli } from "./agent-cli.js";
import * as agentClient from "./agent-client.js";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.js";
import { ReviewApiClient } from "./client.js";
import { createReviewApi } from "./http.js";
import { serveReviewMcp } from "./mcp.js";
import { ReviewStore } from "./store.js";

const store = new ReviewStore(":memory:", {
  validatePins: async () => {},
  validateSource: async () => {},
  validateResource: async () => {},
});

const app = createReviewApi(store);

afterAll(() => store.close());

const client = new ReviewApiClient(
  { serverUrl: "http://review.test", token: "test" },
  async (url, init) => app.request(url.replace("/reviews-api", ""), init),
);

afterEach(async () => {
  // The scratchpad cannot be deleted; every review can.
  for (const { reviewId, kind } of store.list())
    if (kind !== "scratchpad")
      await store.execute({
        commandId: randomUUID(),
        operation: { type: "delete", reviewId },
      });
});

/** Catalog entries that are reviews: listing also makes the scratchpad. */
const reviewsOnly = (entries: { kind?: string }[]) =>
  entries.filter((entry) => entry.kind !== "scratchpad");

it("uses host-advertised tools to edit, retry, reject invalid content and inspect saved IDs", async () => {
  const tools = await client.read<AuthoringTool[]>("/authoring");

  const call = (name: string, args: Parameters<typeof callAuthoringTool>[2]) =>
    callAuthoringTool(
      client,
      tools.find((t) => t.name === `review_${name}`)!,
      args,
    );

  const created = (await call("create", {
    commandId: randomUUID(),
    title: "Authoring",
    pins: { repositoryId: "repo", base: "base", head: "head" },
  })) as { reviewId: string };

  const input = {
    commandId: randomUUID(),
    reviewId: created.reviewId,
    edit: {
      type: "insert",
      content: {
        type: "sequence",
        title: "Save",
        actors: { agent: "Agent", host: "Host" },
        steps: [
          {
            from: "agent",
            to: "host",
            label: "Save",
            explanation: "Validated before saving.",
          },
        ],
      },
    },
  };

  const result = (await call("edit", input)) as { targetId: string };
  expect(await call("edit", input)).toEqual(result);
  expect(store.read(created.reviewId).version).toBe(1);
  expect(
    await call("get", {
      reviewId: created.reviewId,
      targetId: result.targetId,
      format: "json",
    }),
  ).toMatchObject({ type: "sequence", id: result.targetId });
  await expect(
    call("edit", {
      ...input,
      commandId: randomUUID(),
      edit: {
        type: "update",
        targetId: result.targetId,
        changes: { actors: { agent: "Agent" } },
      },
    }),
  ).rejects.toThrow(Error);
  expect(store.read(created.reviewId).version).toBe(1);
  await call("edit", {
    commandId: randomUUID(),
    reviewId: created.reviewId,
    edit: {
      type: "update",
      targetId: result.targetId,
      changes: { title: "Saved" },
    },
  });
  expect(
    await call("get", {
      reviewId: created.reviewId,
      full: true,
      format: "json",
    }),
  ).toMatchObject({
    version: 2,
    document: [{ id: result.targetId, title: "Saved" }],
  });
  expect(
    await call("get", {
      reviewId: created.reviewId,
      version: 1,
      full: true,
      format: "json",
    }),
  ).toMatchObject({ version: 1, document: [{ title: "Save" }] });
  const text = await call("get", { reviewId: created.reviewId, full: true });
  expect(text).toContain(`[${result.targetId}] sequence: Saved`);
  expect(text).toContain("Validated before saving.");
  expect(
    await call("get", { reviewId: created.reviewId, version: 1 }),
  ).toContain("sequence: Save");
  // IDs discovered in the reading view still identify the same editable nodes.
  const stepId = String(text).match(/\[(step-\d+)\]/)![1];
  await call("edit", {
    commandId: randomUUID(),
    reviewId: created.reviewId,
    edit: {
      type: "update",
      targetId: stepId,
      changes: { explanation: "Updated through the reading view." },
    },
  });
  expect(
    await call("get", { reviewId: created.reviewId, targetId: stepId }),
  ).toContain("Updated through the reading view.");
});

it("serves MCP framing without stdout diagnostics and returns host errors as tool errors", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const calls: Array<[string, string, boolean]> = [];

  const server = await serveReviewMcp(
    async () => ({ client }),
    stdin,
    stdout,
    undefined,
    false,
    undefined,
    ({ tool, via, ok }) => void calls.push([tool, via, ok]),
  );

  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk;
  });

  const request = async <Params>(
    id: number,
    method: string,
    params: Params,
  ) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await expect
      .poll(() =>
        output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((reply) => reply.id === id),
      )
      .toBeTruthy();

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((reply) => reply.id === id);
  };

  try {
    await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const list = await request(2, "tools/list", {});
    ListToolsResultSchema.parse(list.result);
    // The Anthropic API rejects these at the top level of a tool input schema.
    expect(
      list.result.tools.filter((tool: AuthoringTool) =>
        ["anyOf", "oneOf", "allOf"].some((key) => key in tool.inputSchema),
      ),
    ).toEqual([]);
    expect(
      list.result.tools.find(
        (tool: AuthoringTool) => tool.name === "session_edit",
      ).inputSchema,
    ).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["sessionId", "commandId", "edit"]),
    });

    const error = await request(3, "tools/call", {
      name: "session_get",
      arguments: { sessionId: "missing" },
    });

    expect(error.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/not found/i) }],
    });

    const next = await request(4, "tools/call", {
      name: "session_list",
      arguments: {},
    });

    expect(reviewsOnly(JSON.parse(next.result.content[0].text))).toEqual([]);

    const created = await store.execute({
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "Readable review",
        pins: { repositoryId: "repo", base: "base", head: "head" },
      },
    });

    const read = await request(5, "tools/call", {
      name: "session_get",
      arguments: { sessionId: created.reviewId },
    });

    expect(read.result.content[0].text.startsWith("# Readable review\n")).toBe(
      true,
    );

    const raw = await request(6, "tools/call", {
      name: "session_get",
      arguments: { sessionId: created.reviewId, full: true, format: "json" },
    });

    expect(JSON.parse(raw.result.content[0].text)).toMatchObject({
      sessionId: created.reviewId,
      document: [],
    });

    await request(7, "tools/call", { name: "my private notes", arguments: {} });

    expect(calls).toEqual([
      ["session_get", "mcp", false],
      ["session_list", "mcp", true],
      ["session_get", "mcp", true],
      ["session_get", "mcp", true],
      ["other", "mcp", false],
    ]);
  } finally {
    await server.close();
  }
});

it("reports each api tool call with its outcome", async () => {
  const connection = vi
    .spyOn(agentClient, "connectReviewApi")
    .mockResolvedValue(client);

  const calls: Array<[string, string, boolean]> = [];

  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

  const run = (argv: string[]) =>
    runReviewAgentCli({
      argv,
      stdout: discard,
      stderr: discard,
      // Queued a tick late, like a real capture: the command must wait.
      onToolCall: async ({ tool, via, ok }) => {
        await new Promise((resolve) => setImmediate(resolve));
        calls.push([tool, via, ok]);
      },
    });

  try {
    expect(await run(["api", "session_list"])).toBe(0);
    expect(await run(["api", "session_get", '{"sessionId":"missing"}'])).toBe(
      1,
    );
    expect(await run(["api", "no_such_tool"])).toBe(1);
    expect(calls).toEqual([
      ["session_list", "api", true],
      ["session_get", "api", false],
    ]);
  } finally {
    connection.mockRestore();
  }
});

it("shows CLI help without requiring Desktop or touching review storage", async () => {
  let output = "";

  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk;
      done();
    },
  });

  expect(
    await runReviewAgentCli({
      argv: ["api", "--help"],
      stdin: Readable.from([]),
      stdout: stream,
      stderr: stream,
      env: { DEV_REVIEW_HOME: "/does-not-exist" },
    }),
  ).toBe(0);
  expect(output).toContain("whiteboard api <tool-name>");
});

it("prints readable CLI output by default and raw objects with --json", async () => {
  const connection = vi
    .spyOn(agentClient, "connectReviewApi")
    .mockResolvedValue(client);

  const created = await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "CLI reading",
      pins: { repositoryId: "repo", base: "base", head: "head" },
    },
  });

  try {
    const read = async (flags: string[]) => {
      let output = "";

      const stdout = new Writable({
        write(chunk, _encoding, done) {
          output += chunk;
          done();
        },
      });

      expect(
        await runReviewAgentCli({
          argv: [
            "api",
            "session_get",
            JSON.stringify({ sessionId: created.reviewId, full: true }),
            ...flags,
          ],
          stdout,
          stderr: stdout,
        }),
      ).toBe(0);

      return output;
    };

    expect((await read([])).startsWith("# CLI reading\n")).toBe(true);
    expect(JSON.parse(await read(["--json"]))).toMatchObject({
      sessionId: created.reviewId,
      document: [],
    });
  } finally {
    connection.mockRestore();
  }
});

it("binds existing content through the host-advertised PR tool", async () => {
  const tools = await client.read<AuthoringTool[]>("/authoring");

  const created = await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "create",
      title: "PR",
      pins: { repositoryId: "repo", base: "base", head: "head" },
    },
  });

  await store.execute({
    commandId: randomUUID(),
    operation: {
      type: "edit",
      reviewId: created.reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Keep the authored review" },
      },
    },
  });

  const authored = store.read(created.reviewId).document;

  await callAuthoringTool(
    client,
    tools.find((tool) => tool.name === "review_repin")!,
    {
      commandId: randomUUID(),
      reviewId: created.reviewId,
      pins: { repositoryId: "repo", base: "base", head: "head" },
      pullRequestUrl: "https://github.com/devdotfast/review/pull/310",
    },
  );
  expect(store.read(created.reviewId).document).toEqual(authored);
  expect(
    store.list().find((review) => review.reviewId === created.reviewId)?.origin,
  ).toEqual({
    pullRequestNumber: 310,
    pullRequestUrl: "https://github.com/devdotfast/review/pull/310",
  });
});

it("tells the server which surface and agent harness made the call", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "agent-origin-"));
  const instanceId = randomUUID();
  const seen: Array<[string | undefined, string | undefined]> = [];

  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, instanceId }));

      return;
    }

    seen.push([
      request.headers["x-review-via"]?.toString(),
      request.headers["x-review-agent"]?.toString(),
    ]);
    response.end("[]");
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number() }).parse(server.address());
    await mkdir(path.join(stateDir, "review-server"), { recursive: true });
    await writeFile(
      path.join(stateDir, "review-server", "server.json"),
      JSON.stringify({
        version: 1,
        instanceId,
        url: `http://127.0.0.1:${port}`,
        serverPid: process.pid,
        token: "token",
      }),
    );

    const discard = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });

    expect(
      await runReviewAgentCli({
        argv: ["api", "tools"],
        stdout: discard,
        stderr: discard,
        env: { DEV_REVIEW_SERVER_DIR: stateDir, CODEX_THREAD_ID: "thread-1" },
      }),
    ).toBe(0);
    expect(seen).toEqual([["api", "codex"]]);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

it("keeps an MCP session on the instance key it first reached", async () => {
  const keys: (string | undefined)[] = [];

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk;
  });

  const server = await serveReviewMcp(
    async (key) => {
      keys.push(key);

      return { client, instance: { key: "preview" } };
    },
    stdin,
    stdout,
    process.stderr,
    false,
    async (problem) => ({ desktopAvailable: false, problem }),
  );

  const reply = async (id: number, method: string, params: JsonObject) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    let found: { result: { isError?: boolean; content?: { text: string }[] } };
    await expect
      .poll(() => {
        found = output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((line) => line.id === id);

        return found;
      })
      .toBeTruthy();

    return found!.result;
  };

  try {
    await reply(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await reply(2, "tools/list", {});

    const result = await reply(3, "tools/call", {
      name: "session_list",
      arguments: {},
    });

    // Every connect after the first names the latched key, so a Desktop that
    // restarts under the same key is followed and another key is never chosen.
    expect(keys).toEqual([undefined, "preview"]);
    expect(result.isError).toBeFalsy();
  } finally {
    await server.close();
  }
});
