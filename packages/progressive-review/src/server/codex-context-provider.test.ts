import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { JsonObject } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { CodexContextProvider } from "./codex-context-provider";

const Frame = z.object({
  type: z.string(),
  requestId: z.string(),
  response: z.object({ canHandle: z.boolean() }).optional(),
  result: z
    .object({
      ideContext: z.object({
        activeFile: z.object({
          path: z.string(),
          activeSelectionContent: z.string(),
          selection: z.object({
            end: z.object({ line: z.number(), character: z.number() }),
          }),
        }),
      }),
    })
    .optional(),
});

function reader(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  const frames: z.infer<typeof Frame>[] = [];
  const waiters: Array<(frame: z.infer<typeof Frame>) => void> = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0);

      const frame = Frame.parse(
        JSON.parse(buffer.subarray(4, size + 4).toString()),
      );

      buffer = buffer.subarray(size + 4);
      const waiter = waiters.shift();

      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });

  return () =>
    frames.length
      ? Promise.resolve(frames.shift()!)
      : new Promise<z.infer<typeof Frame>>((resolve) => waiters.push(resolve));
}

function frame(value: JsonObject) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);

  return Buffer.concat([header, body]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("serves in-memory Unicode selections, isolates workspaces, and retains the most recent selection across heartbeats", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-ide-"));
  vi.stubEnv("CODEX_HOME", home);
  await mkdir(path.join(home, "ipc"));
  const server = net.createServer();
  server.listen(path.join(home, "ipc", "ipc.sock"));
  await once(server, "listening");
  const provider = new CodexContextProvider();
  const connection = once(server, "connection");
  let socket: net.Socket | undefined;

  try {
    const input = {
      roots: [home],
      file: path.join(home, "review.mdx"),
      codeFile: path.join(home, "source.ts"),
      title: "Review",
      sequence: 1,
    };

    await provider.publish("one", { ...input, text: "Selected prose\n😀" });
    [socket] = await connection;
    const next = reader(socket!);
    const initialize = await next();
    socket!.write(
      frame({
        type: "response",
        requestId: initialize.requestId,
        resultType: "success",
        result: { clientId: "review-test" },
      }),
    );

    const request = {
      type: "request",
      requestId: "read",
      method: "ide-context",
      version: 0,
      params: { workspaceRoot: home },
    };

    const bytes = frame(request);
    socket!.write(bytes.subarray(0, 2));
    socket!.write(bytes.subarray(2, 11));
    socket!.write(bytes.subarray(11));
    const first = (await next()).result!.ideContext.activeFile;
    expect(first.activeSelectionContent).toBe("Selected prose\n😀");
    expect(first.selection.end).toEqual({ line: 0, character: 0 });
    expect(first.path).toBe(input.file);
    expect(provider.preview("one")).toContain(`- source.ts: ${input.codeFile}`);
    await provider.publish("two", { ...input, text: "Sequence edge A → B" });
    expect(provider.touch("one", 1)).toBe(true);
    socket!.write(frame(request));
    expect(
      (await next()).result!.ideContext.activeFile.activeSelectionContent,
    ).toBe("Sequence edge A → B");

    const rejectedRequests: JsonObject[] = [
      { params: { workspaceRoot: "/unrelated" } },
      { hostId: "remote" },
      { version: 1 },
      { params: {} },
    ];

    for (const overrides of rejectedRequests) {
      socket!.write(
        frame({
          type: "client-discovery-request",
          requestId: "discover",
          request: { ...request, ...overrides },
        }),
      );
      expect((await next()).response?.canHandle).toBe(false);
    }

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 46000);
    socket!.write(
      frame({
        type: "client-discovery-request",
        requestId: "expired",
        request,
      }),
    );
    expect((await next()).response?.canHandle).toBe(false);
  } finally {
    provider.remove("one");
    provider.remove("two");
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
