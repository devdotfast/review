import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type JsonObject,
  type JsonValue,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentServerOptions } from "./native-session";
import { OpencodeAgentServer } from "./opencode";

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
const assistant = (id: string, text: string, completed?: number) => {
  const time: JsonObject = { created: 1_500 };
  if (completed !== undefined) time.completed = completed;
  const message: JsonObject = {
    info: { id, sessionID: "ses_1", role: "assistant", time },
    parts: [{ id: `${id}-p`, type: "text", text }],
  };
  return message;
};

/** A fake `opencode serve`: sessions, prompts, messages, and an event stream. */
async function fakeOpencode() {
  const requests: Array<{
    method: string;
    path: string;
    directory: string | null;
    body: JsonValue;
  }> = [];
  const messages: JsonValue[] = [];
  const listeners = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const body = raw ? parseJsonText(raw) : null;
      requests.push({
        method: request.method ?? "",
        path: url.pathname,
        directory: url.searchParams.get("directory"),
        body,
      });
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
          `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`,
        );
        listeners.add(response);
        response.on("close", () => listeners.delete(response));
        return;
      }
      const reply = (value: JsonValue) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/session" && request.method === "POST")
        return reply({
          id: "ses_new",
          directory: url.searchParams.get("directory"),
        });
      // Sessions live in a project; a lookup only finds them in that directory.
      if (url.pathname === "/project")
        return reply([
          { id: "p-other", worktree: "/repo/other" },
          { id: "p-source", worktree: "/repo/source" },
        ]);
      if (
        (url.pathname === "/session/ses_src" ||
          url.pathname === "/session/ses_1") &&
        request.method === "GET"
      ) {
        if (url.searchParams.get("directory") !== "/repo/source") {
          response.writeHead(404).end();
          return;
        }
        return reply({ id: url.pathname.slice(9), directory: "/repo/source" });
      }
      if (url.pathname === "/session/ses_src/fork")
        return reply({ id: "ses_1", directory: "/repo/source" });
      if (url.pathname === "/session/ses_1/prompt_async") {
        const id = String(jsonObject(body)?.messageID);
        const message = user(id, "question");
        messages.push(message);
        for (const listener of listeners)
          listener.write(
            `data: ${JSON.stringify({ payload: { type: "message.updated", properties: { sessionID: "ses_1", info: message.info } } })}\n\n`,
          );
        return reply({});
      }
      if (url.pathname === "/session/ses_1/abort") return reply(true);
      if (url.pathname.startsWith("/session/ses_1/message/")) {
        const id = url.pathname.split("/").at(-1);
        const message = messages.find(
          (message) => jsonObject(jsonObject(message)?.info)?.id === id,
        );
        if (message) return reply(message);
      }
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
    emit(event: JsonValue) {
      for (const listener of listeners)
        listener.write(`data: ${JSON.stringify({ payload: event })}\n\n`);
    },
  };
}

describe("OpenCode live capture", () => {
  it("captures submitted and completed messages without reading inherited history, then waits for idle on interrupt", async () => {
    const oc = await fakeOpencode();
    oc.messages.push(user("inherited", "old question"));
    const server = new OpencodeAgentServer(await options(), oc.host);
    await server.launch({
      session: { forkOf: "ses_src" },
      cwd: "/repo/source",
      prompt: { id: "review-ask", text: "question" },
    });
    const pipe = await server.updates("ses_1");
    const iterator = pipe.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ status: "running" });
    expect((await iterator.next()).value).toMatchObject({
      message: { id: "review-ask", role: "user" },
    });
    oc.emit({ type: "sync", syncEvent: { type: "session.updated.1" } });
    const reply = assistant("answer", "done", 2000);
    oc.messages.push(reply);
    oc.emit({
      type: "message.updated",
      properties: { sessionID: "ses_1", info: jsonObject(reply)?.info ?? null },
    });
    expect((await iterator.next()).value).toMatchObject({
      message: { id: "answer", body: "done" },
    });
    let stopped = false;
    const stopping = server.interrupt("ses_1").then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    oc.emit({
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "MessageAbortedError" },
      },
    });
    oc.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await stopping;
    expect(
      oc.requests.some((request) => request.path === "/session/ses_1/message"),
    ).toBe(false);
    await server.close();
  });
});
