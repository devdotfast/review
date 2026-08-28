import type { ChildProcess } from "node:child_process";

import {
  type OpenCodeHttpClient,
  type StartOpenCodeServerInput,
  isOpenCodeMessageId,
  isOpenCodeProcessRunning,
  nonEmptyString,
  startOpenCodeServer,
  stopOpenCodeProcess,
} from "./opencode-http";
import { isJsonRecord } from "./transcript-json";

export interface OpenCodeSourceClient {
  messages(sessionId: string, directory: string): Promise<unknown>;
  fork(
    sessionId: string,
    messageId: string,
    directory: string,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export async function forkOpenCodeSourceSession(input: {
  sessionId: string;
  messageId: string;
  sourceDirectory: string;
  sourceWorktree: string;
  targetDirectory: string;
  connect?: (cwd: string) => Promise<OpenCodeSourceClient>;
}): Promise<string> {
  if (!input.sourceWorktree.trim()) {
    throw new Error("OpenCode source worktree is missing.");
  }
  const client = await (input.connect ?? OpenCodeSourceHttpClient.connect)(
    input.sourceDirectory,
  );
  try {
    const messages = await client.messages(
      input.sessionId,
      input.sourceDirectory,
    );
    validateOpenCodeToolCallMessage(messages, {
      sessionId: input.sessionId,
      messageId: input.messageId,
    });
    const fork = await client.fork(
      input.sessionId,
      input.messageId,
      input.targetDirectory,
    );
    if (!isJsonRecord(fork) || !nonEmptyString(fork.id)) {
      throw new Error("OpenCode returned an invalid forked session.");
    }
    return fork.id;
  } finally {
    await client.close();
  }
}

export function validateOpenCodeToolCallMessage(
  value: unknown,
  expected: { sessionId: string; messageId: string },
): void {
  if (!isOpenCodeMessageId(expected.messageId)) {
    throw new Error("OpenCode invocation message ID is invalid.");
  }
  if (!Array.isArray(value)) {
    throw new Error("OpenCode returned an invalid session message list.");
  }
  const matches = value.filter(
    (entry) =>
      isJsonRecord(entry) &&
      isJsonRecord(entry.info) &&
      entry.info.id === expected.messageId,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "OpenCode invocation message was not found in the source session."
        : "OpenCode invocation message identity is ambiguous.",
    );
  }
  const message = matches[0]!;
  const info = message.info as Record<string, unknown>;
  if (
    info.sessionID !== expected.sessionId ||
    info.role !== "assistant" ||
    !Array.isArray(message.parts)
  ) {
    throw new Error(
      "OpenCode invocation message does not match the source session.",
    );
  }
  const toolCalls = message.parts.filter(
    (part: unknown) =>
      isJsonRecord(part) && part.type === "tool" && part.tool === "review",
  );
  if (toolCalls.length !== 1) {
    throw new Error(
      toolCalls.length === 0
        ? "OpenCode invocation message is not a Review tool call."
        : "OpenCode invocation message contains ambiguous Review tool calls.",
    );
  }
}

export class OpenCodeSourceHttpClient implements OpenCodeSourceClient {
  private constructor(
    readonly child: ChildProcess,
    readonly http: OpenCodeHttpClient,
    readonly shutdownTimeoutMs?: number,
  ) {}

  static async connect(
    cwd: string,
    options: Omit<StartOpenCodeServerInput, "cwd" | "stdin"> = {},
  ): Promise<OpenCodeSourceHttpClient> {
    const process = await startOpenCodeServer({
      ...options,
      cwd,
      detached: false,
      stdin: "pipe",
    });
    return new OpenCodeSourceHttpClient(
      process.child,
      process.http,
      options.shutdownTimeoutMs,
    );
  }

  messages(sessionId: string, directory: string): Promise<unknown> {
    return this.http.json(
      `/session/${encodeURIComponent(sessionId)}/message`,
      directory,
    );
  }

  fork(
    sessionId: string,
    messageId: string,
    directory: string,
  ): Promise<unknown> {
    return this.http.json(
      `/session/${encodeURIComponent(sessionId)}/fork`,
      directory,
      {
        method: "POST",
        body: JSON.stringify({ messageID: messageId }),
      },
    );
  }

  async close(): Promise<void> {
    if (!isOpenCodeProcessRunning(this.child)) return;
    await this.http
      .json("/instance/dispose", undefined, {
        method: "POST",
      })
      .catch(() => undefined);
    this.child.stdin?.end();
    await stopOpenCodeProcess(this.child, this.shutdownTimeoutMs);
  }
}
