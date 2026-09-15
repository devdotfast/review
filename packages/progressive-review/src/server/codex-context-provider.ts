import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import type { JsonObject } from "@dev.fast/review-protocol";
import { z } from "zod";

const MAX_FRAME = 1024 * 1024;

const LEASE_MS = 45_000;

const Request = z.object({
  type: z.literal("request"),
  requestId: z.string(),
  method: z.string(),
  version: z.number().optional(),
  hostId: z.string().optional(),
  params: z.object({ workspaceRoot: z.string().optional() }).optional(),
});

const Message = z.discriminatedUnion("type", [
  Request,
  z.object({
    type: z.literal("client-discovery-request"),
    requestId: z.string(),
    request: Request,
  }),
  z.object({
    type: z.literal("response"),
    requestId: z.string(),
    resultType: z.string(),
    result: z.object({ clientId: z.string() }).optional(),
  }),
]);

interface Snapshot {
  roots: string[];
  file: string;
  codeFile?: string;
  tabs?: { path: string; label: string }[];
  text: string;
  title: string;
  sequence: number;
  selectedAt: number;
  expiresAt: number;
}

/** One provider per backend process. Multiple Review windows share one election. */
export class CodexContextProvider {
  private snapshots = new Map<string, Snapshot>();
  private socket?: net.Socket;
  private retry?: ReturnType<typeof setTimeout>;
  private buffer = Buffer.alloc(0);
  private clientId?: string;
  private registration = "";
  private clock = 0;

  get connected() {
    return Boolean(this.socket && this.clientId);
  }

  publish(
    key: string,
    input: {
      roots: string[];
      file: string;
      codeFile?: string;
      tabs?: { path: string; label: string }[];
      text: string;
      title: string;
      sequence: number;
    },
  ) {
    const text =
      input.text.length > 39000
        ? input.text.slice(0, 38900) + "\n[Review context truncated]"
        : input.text;

    const old = this.snapshots.get(key);
    this.snapshots.set(key, {
      roots: input.roots.map(canonicalPath),
      file: input.file,
      codeFile: input.codeFile,
      tabs: input.tabs,
      text,
      title: input.title,
      sequence: input.sequence,
      selectedAt:
        old?.sequence === input.sequence ? old.selectedAt : ++this.clock,
      expiresAt: Date.now() + LEASE_MS,
    });
    this.connect();
  }

  /** Render the same snapshot supplied over IPC, including Codex's IDE wrapper. */
  preview(key: string): string | null {
    const snapshot = this.snapshots.get(key);

    if (!snapshot) return null;

    return [
      "# Context from my IDE setup:",
      "",
      `## Active file: ${snapshot.file}`,
      "",
      ...(snapshot.text
        ? ["## Active selection of the file:", snapshot.text]
        : []),
      "## Open tabs:",
      ...this.openTabs(snapshot).map((tab) => `- ${tab.label}: ${tab.path}`),
    ].join("\n");
  }

  private openTabs(snapshot: Snapshot) {
    return (
      snapshot.tabs ?? [
        { path: snapshot.file, label: snapshot.title },
        ...(snapshot.codeFile
          ? [
              {
                path: snapshot.codeFile,
                label: path.basename(snapshot.codeFile),
              },
            ]
          : []),
      ]
    );
  }

  touch(key: string, sequence: number) {
    const snapshot = this.snapshots.get(key);

    if (!snapshot || snapshot.sequence !== sequence) return false;
    snapshot.expiresAt = Date.now() + LEASE_MS;
    this.connect();

    return true;
  }

  remove(key: string) {
    this.snapshots.delete(key);

    if (!this.snapshots.size) this.disconnect();
  }

  private disconnect() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.clientId = undefined;
  }

  private choose(request: z.infer<typeof Request>) {
    for (const [key, value] of this.snapshots)
      if (value.expiresAt < Date.now()) this.snapshots.delete(key);

    if (
      request.method !== "ide-context" ||
      (request.version ?? 0) !== 0 ||
      (request.hostId && request.hostId !== "local")
    )
      return;
    const root = request.params?.workspaceRoot;

    // Do not leak a selection into an unscoped or unrelated task.
    if (!root) return;

    return [...this.snapshots.values()]
      .filter((s) =>
        s.roots.some((r) => {
          const relative = path.relative(canonicalPath(root), r);

          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          );
        }),
      )
      .sort((a, b) => b.selectedAt - a.selectedAt)[0];
  }

  private send(message: JsonObject) {
    if (!this.socket?.writable) return;
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  private connect() {
    if (this.socket || this.retry || !this.snapshots.size) return;
    const home = process.env.CODEX_HOME || path.join(homedir(), ".codex");

    const endpoint =
      process.platform === "win32"
        ? "\\\\.\\pipe\\codex-ipc"
        : path.join(home, "ipc", "ipc.sock");

    const socket = net.createConnection(endpoint);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("connect", () => {
      this.registration = randomUUID();
      this.send({
        type: "request",
        requestId: this.registration,
        sourceClientId: "review",
        version: 0,
        method: "initialize",
        params: { clientType: "ide" },
      });
    });
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);

        if (size > MAX_FRAME) {
          socket.destroy();

          return;
        }

        if (this.buffer.length < size + 4) return;
        const frame = this.buffer.subarray(4, size + 4);
        this.buffer = this.buffer.subarray(size + 4);

        try {
          const parsed = Message.safeParse(JSON.parse(frame.toString("utf8")));

          if (parsed.success) this.handle(parsed.data);
        } catch {
          socket.destroy();

          return;
        }
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clientId = undefined;

      for (const [key, value] of this.snapshots)
        if (value.expiresAt < Date.now()) this.snapshots.delete(key);

      if (this.snapshots.size)
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.connect();
        }, 3000);
      this.retry?.unref();
    });
    socket.unref();
  }

  private handle(message: z.infer<typeof Message>) {
    if (message.type === "response") {
      if (
        message.requestId === this.registration &&
        message.resultType === "success"
      )
        this.clientId = message.result?.clientId;

      return;
    }

    const request = message.type === "request" ? message : message.request;
    const snapshot = this.choose(request);

    if (message.type === "client-discovery-request") {
      this.send({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: Boolean(snapshot) },
      });

      return;
    }

    if (!snapshot) {
      this.send({
        type: "response",
        requestId: request.requestId,
        resultType: "error",
        error: "no-handler-for-request",
      });

      return;
    }

    this.send({
      type: "response",
      requestId: request.requestId,
      resultType: "success",
      method: "ide-context",
      handledByClientId: this.clientId ?? "review",
      result: {
        ideContext: {
          activeFile: {
            path: snapshot.file,
            label: snapshot.title,
            selection: {
              start: { line: 0, character: 0 },
              // Semantic selections need not correspond to MDX source ranges.
              end: { line: 0, character: 0 },
            },
            activeSelectionContent: snapshot.text,
          },
          openTabs: this.openTabs(snapshot),
        },
      },
    });
  }
}

export const reviewCodexContext = new CodexContextProvider();

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
