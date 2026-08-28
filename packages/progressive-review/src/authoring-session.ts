import path from "node:path";

export type ReviewAgentHarness = "claude-code" | "codex" | "opencode" | "pi";

export interface OpenCodeInvocationContext {
  sessionId: string;
  messageId: string;
  directory: string;
  worktree: string;
}

export interface SessionRef {
  harness: ReviewAgentHarness;
  sessionId: string;
}

export type AuthoringSessionRef =
  | {
      harness: "opencode";
      sessionId: string;
      messageId: string;
      directory: string;
      worktree: string;
    }
  | {
      harness: Exclude<ReviewAgentHarness, "opencode">;
      sessionId: string;
    };

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export const AUTHORING_AGENT_SESSION_ENV = "DEV_FAST_AGENT_SESSION";

export function authoringSessionKey(ref: SessionRef): string {
  return `${ref.harness}:${ref.sessionId}`;
}

export function freshSourceSessionKey(harness: ReviewAgentHarness): string {
  return `fresh:${harness}`;
}

export function parseFreshSourceSessionHarness(
  value: string | null | undefined,
): ReviewAgentHarness | undefined {
  const prefix = "fresh:";
  if (!value?.startsWith(prefix)) return undefined;
  const harness = value.slice(prefix.length);
  return isReviewAgentHarness(harness) ? harness : undefined;
}

export function parseAuthoringSessionKey(
  value: string | null | undefined,
): SessionRef | undefined {
  const separator = value?.indexOf(":") ?? -1;
  if (!value || separator < 1 || separator === value.length - 1) {
    return undefined;
  }
  const harness = value.slice(0, separator);
  const sessionId = value.slice(separator + 1);
  return isReviewAgentHarness(harness) ? { harness, sessionId } : undefined;
}

export function resolveAuthoringSessionRef(
  env: EnvironmentValues,
  openCode?: Partial<OpenCodeInvocationContext>,
): AuthoringSessionRef | undefined {
  if (openCode) return openCodeSessionRef(openCode);

  const hosted = readEnvValue(env[AUTHORING_AGENT_SESSION_ENV]);
  if (hosted) {
    const ref = parseAuthoringSessionKey(hosted);
    if (!ref) {
      throw new Error(
        `${AUTHORING_AGENT_SESSION_ENV} has an invalid authoring session reference.`,
      );
    }
    if (ref.harness === "opencode") {
      throw new Error(
        `${AUTHORING_AGENT_SESSION_ENV} cannot carry OpenCode invocation context.`,
      );
    }
    return { harness: ref.harness, sessionId: ref.sessionId };
  }

  const codexThreadId = readEnvValue(env.CODEX_THREAD_ID);
  if (codexThreadId) return { harness: "codex", sessionId: codexThreadId };

  const claudeSessionId =
    readEnvValue(env.CLAUDE_CODE_SESSION_ID) ??
    readEnvValue(env.CLAUDE_SESSION_ID);
  if (claudeSessionId) {
    return { harness: "claude-code", sessionId: claudeSessionId };
  }

  const piSessionId = readEnvValue(env.PI_SESSION_ID);
  if (piSessionId) return { harness: "pi", sessionId: piSessionId };

  return undefined;
}

function isReviewAgentHarness(value: string): value is ReviewAgentHarness {
  return (
    value === "claude-code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "pi"
  );
}

function openCodeSessionRef(
  input: Partial<OpenCodeInvocationContext>,
): AuthoringSessionRef {
  const sessionId = readEnvValue(input.sessionId);
  const messageId = readEnvValue(input.messageId);
  const directory = readEnvValue(input.directory);
  const worktree = readEnvValue(input.worktree);
  if (!sessionId || !messageId || !directory || !worktree) {
    throw new Error("OpenCode invocation context is incomplete.");
  }
  if (!path.isAbsolute(directory) || !path.isAbsolute(worktree)) {
    throw new Error("OpenCode directory and worktree must be absolute paths.");
  }
  return {
    harness: "opencode",
    sessionId,
    messageId,
    directory,
    worktree,
  };
}

function readEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
