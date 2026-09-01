import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  type CodexNotification,
  type Transport,
} from "./codex-app-server";

function fakeTransport(): Transport & {
  sent: string[];
  receive(line: string): void;
  drop(): void;
} {
  const lineListeners: Array<(line: string) => void> = [];
  const closeListeners: Array<(error?: Error) => void> = [];
  return {
    sent: [],
    send(line) {
      this.sent.push(line);
    },
    onLine: (listener) => lineListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: async () => undefined,
    receive: (line) => {
      for (const listener of lineListeners) listener(line);
    },
    drop: () => {
      for (const listener of closeListeners) listener();
    },
  };
}

describe("CodexAppServerClient", () => {
  it("matches responses to requests by id and fans out notifications", async () => {
    const transport = fakeTransport();
    const client = new CodexAppServerClient(transport);
    const seen: CodexNotification[] = [];
    client.onNotification((notification) => seen.push(notification));

    const pending = client.request("thread/start", { cwd: "/tmp" });
    const sent = JSON.parse(transport.sent[0]!) as { id: number };
    transport.receive(
      JSON.stringify({ method: "turn/started", params: { threadId: "t" } }),
    );
    transport.receive(
      JSON.stringify({ id: sent.id, result: { thread: { id: "t" } } }),
    );
    expect(await pending).toEqual({ thread: { id: "t" } });
    expect(seen).toEqual([
      { method: "turn/started", params: { threadId: "t" } },
    ]);
  });

  it("rejects a request the server answers with an error", async () => {
    const transport = fakeTransport();
    const client = new CodexAppServerClient(transport);
    const pending = client.request("thread/read", { threadId: "t" });
    const sent = JSON.parse(transport.sent[0]!) as { id: number };
    transport.receive(
      JSON.stringify({
        id: sent.id,
        error: { code: -32600, message: "no rollout found for thread id t" },
      }),
    );
    await expect(pending).rejects.toThrow("no rollout found for thread id t");
  });

  it("fails every pending request when the connection drops", async () => {
    const transport = fakeTransport();
    const client = new CodexAppServerClient(transport);
    const pending = client.request("thread/read", { threadId: "t" });
    transport.drop();
    await expect(pending).rejects.toThrow("connection closed");
    expect(client.closed).toBe(true);
    await expect(client.request("thread/read", {})).rejects.toThrow(
      "connection closed",
    );
  });
});
