import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentServerOptions, SessionUpdate } from "./native-session";
import { OpencodeAgentServer, projectOpencodeMessages } from "./opencode";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function options(): Promise<AgentServerOptions> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-opencode-"));
  temporaryDirectories.push(directory);
  return {
    runtimeDirectory: directory,
    desktopEndpoint: { baseUrl: "http://127.0.0.1:4000", token: "s" },
  };
}

const user = (id: string, text: string, created = 1_000) => ({
  info: { id, sessionID: "ses_1", role: "user", time: { created } },
  parts: [{ id: `${id}-p`, type: "text", text }],
});
const assistant = (id: string, text: string, completed?: number) => ({
  info: {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1_500, ...(completed ? { completed } : {}) },
  },
  parts: [{ id: `${id}-p`, type: "text", text }],
});

/** A fake `opencode serve`: sessions, prompts, messages, and an event stream. */
async function fakeOpencode() {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const messages: unknown[] = [];
  const listeners = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      requests.push({ method: request.method ?? "", path: url.pathname, body });
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from("opencode:pw").toString("base64")}`
      ) {
        response.writeHead(401).end();
        return;
      }
      if (url.pathname === "/global/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
        );
        listeners.add(response);
        response.on("close", () => listeners.delete(response));
        return;
      }
      const reply = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/session" && request.method === "POST")
        return reply({ id: "ses_new" });
      if (url.pathname === "/session/ses_src/fork")
        return reply({ id: "ses_1" });
      if (url.pathname === "/session/ses_1/prompt_async") return reply({});
      if (url.pathname === "/session/ses_1/message") return reply(messages);
      response.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    messages,
    host: {
      endpoint: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        password: "pw",
      }),
      close: async () => undefined,
    },
    emit(event: unknown) {
      for (const listener of listeners)
        listener.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  };
}

async function nextUpdates(
  updates: AsyncIterable<SessionUpdate>,
  count: number,
) {
  const collected: SessionUpdate[] = [];
  for await (const update of updates) {
    collected.push(update);
    if (collected.length === count) break;
  }
  return collected;
}

describe("projectOpencodeMessages", () => {
  it("keeps user messages and completed, error-free assistant messages", () => {
    expect(
      projectOpencodeMessages([
        user("msg_1", "hello"),
        assistant("msg_2", "still streaming"),
        assistant("msg_3", "done", 2_000),
        {
          ...assistant("msg_4", "broken", 2_500),
          info: {
            ...assistant("msg_4", "broken", 2_500).info,
            error: { name: "UnknownError" },
          },
        },
      ]),
    ).toEqual([
      {
        role: "user",
        body: "hello",
        createdAt: "1970-01-01T00:00:01.000Z",
        messageId: "msg_1",
      },
      {
        role: "assistant",
        body: "done",
        createdAt: "1970-01-01T00:00:02.000Z",
        messageId: "msg_3",
      },
    ]);
  });
});

describe("OpencodeAgentServer", () => {
  it("forks, prompts, and attaches the TUI to the shared server", async () => {
    const oc = await fakeOpencode();
    const server = new OpencodeAgentServer(await options(), oc.host);
    const { sessionId, command } = await server.launch({
      session: { forkOf: "ses_src" },
      prompt: "Explain this",
      cwd: "/tmp/tutorial",
    });
    expect(sessionId).toBe("ses_1");
    const calls = oc.requests.filter(
      (request) => request.path !== "/global/event",
    );
    expect(calls.map((request) => `${request.method} ${request.path}`)).toEqual(
      ["POST /session/ses_src/fork", "POST /session/ses_1/prompt_async"],
    );
    expect(calls[1]?.body).toEqual({
      parts: [{ type: "text", text: "Explain this" }],
    });
    expect(command.executable).toBe("opencode");
    expect(command.args).toEqual([
      "attach",
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      "--session",
      "ses_1",
      "--dir",
      "/tmp/tutorial",
    ]);
    expect(command.env.OPENCODE_SERVER_PASSWORD).toBe("pw");
    expect(command.env.DEV_FAST_REVIEW_AGENT_THREAD_URL).toBe(
      "http://127.0.0.1:4000/native-agent-events/opencode/ses_1/thread",
    );
    await server.close();
  });

  it("snapshots the session, then re-reads it when the event stream names it", async () => {
    const oc = await fakeOpencode();
    oc.messages.push(
      user("msg_1", "first"),
      assistant("msg_2", "answer one", 2_000),
    );
    const server = new OpencodeAgentServer(await options(), oc.host);
    await server.launch({ session: { resume: "ses_1" }, cwd: "/tmp/tutorial" });
    const pipe = await server.updates("ses_1");
    expect(pipe.snapshot.messages.map((message) => message.body)).toEqual([
      "first",
      "answer one",
    ]);

    oc.messages.push(
      user("msg_3", "second", 3_000),
      assistant("msg_4", "streaming"),
    );
    oc.emit({
      type: "message.updated",
      properties: { info: { id: "msg_3", sessionID: "ses_1", role: "user" } },
    });
    oc.messages.pop();
    oc.messages.push(assistant("msg_4", "answer two", 4_000));
    oc.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    // One pass over the pipe: iterating it twice would close the queue.
    expect(
      (await nextUpdates(pipe.updates, 2)).map((update) => update.message.body),
    ).toEqual(["second", "answer two"]);
    await pipe.close();
    await server.close();
  });
});
