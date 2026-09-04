import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isJsonRecord } from "./native-agent/transcript-json";

export const OPENCODE_SESSION_RECORD = "opencode_session";
export const OPENCODE_MESSAGE_RECORD = "opencode_message";

/** OpenCode session ids are `ses_` followed by a sortable id. */
export function isOpenCodeSessionId(sessionId: string): boolean {
  return sessionId.startsWith("ses_");
}

/**
 * OpenCode keeps sessions in its own database rather than a transcript file.
 * `opencode export` renders one as JSON; this writes that as the JSONL trace
 * the rest of the pipeline expects: one session header record, then one
 * record per message with its parts stripped of provider metadata and inline
 * file data. Returns null when OpenCode has no such session.
 */
export async function exportOpenCodeTrace(input: {
  sessionId: string;
  root: string;
}): Promise<string | null> {
  mkdirSync(input.root, { recursive: true });
  const destination = path.join(input.root, `${input.sessionId}.jsonl`);
  const staging = `${destination}.tmp-${process.pid}`;
  const raw = await runOpenCodeExport(input.sessionId, `${staging}.json`);
  if (raw === null) return null;
  const exported = JSON.parse(raw) as unknown;
  if (!isJsonRecord(exported) || !isJsonRecord(exported.info)) {
    throw new Error(
      `opencode export ${input.sessionId} returned no session info.`,
    );
  }
  if (!Array.isArray(exported.messages)) {
    throw new Error(
      `opencode export ${input.sessionId} returned no message list.`,
    );
  }
  const lines = [
    JSON.stringify({
      type: OPENCODE_SESSION_RECORD,
      ...pick(exported.info, [
        "id",
        "parentID",
        "directory",
        "title",
        "version",
        "time",
      ]),
    }),
    ...exported.messages.map((message) =>
      JSON.stringify(traceMessageRecord(message)),
    ),
  ];
  writeFileSync(staging, `${lines.join("\n")}\n`, "utf8");
  renameSync(staging, destination);
  return destination;
}

/**
 * Runs `opencode export` with stdout on a file. OpenCode exits before a pipe
 * drains, so a piped export is cut off at 128 KiB; a file descriptor is not.
 * Resolves to the exported JSON, or null when OpenCode has no such session.
 */
function runOpenCodeExport(
  sessionId: string,
  stdoutPath: string,
): Promise<string | null> {
  const fd = openSync(stdoutPath, "w");
  return new Promise<string | null>((resolve, reject) => {
    // `--pure` skips user plugins, so the Review trace plugin cannot fire
    // hooks from inside the export it triggered.
    const child = spawn("opencode", ["export", sessionId, "--pure"], {
      stdio: ["ignore", fd, "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const stderrStream = child.stderr;
    if (!stderrStream) {
      throw new Error("opencode export did not open a stderr pipe.");
    }
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      closeSync(fd);
      rmSync(stdoutPath, { force: true });
      reject(
        new Error(`opencode export ${sessionId} failed: ${error.message}`),
      );
    });
    child.once("exit", (code) => {
      closeSync(fd);
      try {
        if (code === 0) {
          resolve(readFileSync(stdoutPath, "utf8"));
        } else if (stderr.includes("Session not found")) {
          resolve(null);
        } else {
          reject(
            new Error(
              `opencode export ${sessionId} exited with ${code}: ${stderr.trim()}`,
            ),
          );
        }
      } finally {
        rmSync(stdoutPath, { force: true });
      }
    });
  });
}

function traceMessageRecord(message: unknown): Record<string, unknown> {
  if (!isJsonRecord(message) || !isJsonRecord(message.info)) {
    throw new Error("opencode export returned a message without info.");
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return {
    type: OPENCODE_MESSAGE_RECORD,
    info: pick(message.info, [
      "id",
      "sessionID",
      "role",
      "time",
      "error",
      "agent",
      "modelID",
      "providerID",
    ]),
    parts: parts.flatMap((part) =>
      isJsonRecord(part) ? [tracePart(part)] : [],
    ),
  };
}

function tracePart(part: Record<string, unknown>): Record<string, unknown> {
  const common = pick(part, ["id", "type"]);
  switch (part.type) {
    case "text":
      return { ...common, ...pick(part, ["text", "ignored", "synthetic"]) };
    case "reasoning":
      return { ...common, ...pick(part, ["text", "time"]) };
    case "tool":
      return {
        ...common,
        ...pick(part, ["tool", "callID"]),
        state: isJsonRecord(part.state)
          ? pick(part.state, [
              "status",
              "input",
              "output",
              "error",
              "title",
              "time",
            ])
          : {},
      };
    case "file":
      return { ...common, ...pick(part, ["mime", "filename"]) };
    case "patch":
      return { ...common, ...pick(part, ["hash", "files"]) };
    case "compaction":
      return { ...common, ...pick(part, ["auto"]) };
    default:
      return common;
  }
}

function pick(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) picked[key] = value[key];
  }
  return picked;
}
