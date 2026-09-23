export type WhiteboardAgentHarness =
  | "claude-code"
  | "codex"
  | "opencode"
  | "pi";

export interface SessionRef {
  harness: WhiteboardAgentHarness;
  sessionId: string;
}

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export const AUTHORING_AGENT_SESSION_ENV = "DEV_FAST_AGENT_SESSION";

export function authoringSessionKey(ref: SessionRef): string {
  return `${ref.harness}:${ref.sessionId}`;
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

  return isWhiteboardAgentHarness(harness) ? { harness, sessionId } : undefined;
}

export function resolveAuthoringSessionRef(
  env: EnvironmentValues,
): SessionRef | undefined {
  const hosted = readEnvValue(env[AUTHORING_AGENT_SESSION_ENV]);

  if (hosted) {
    const ref = parseAuthoringSessionKey(hosted);

    if (!ref) {
      throw new Error(
        `${AUTHORING_AGENT_SESSION_ENV} has an invalid authoring session reference.`,
      );
    }

    return ref;
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

function isWhiteboardAgentHarness(
  value: string,
): value is WhiteboardAgentHarness {
  return (
    value === "claude-code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "pi"
  );
}

function readEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}
