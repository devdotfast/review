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

import {
  type JsonObject,
  type JsonValue,
  jsonArray,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

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
  const exported = jsonObject(parseJsonText(raw));
  const info = jsonObject(exported?.info);
  if (!exported || !info) {
    throw new Error(
      `opencode export ${input.sessionId} returned no session info.`,
    );
  }
  const messages = jsonArray(exported.messages);
  if (!messages) {
    throw new Error(
      `opencode export ${input.sessionId} returned no message list.`,
    );
  }
  const header: JsonObject = {
    type: OPENCODE_SESSION_RECORD,
    ...pick(info, ["id", "parentID", "directory", "title", "version", "time"]),
  };
  const lines = [
    JSON.stringify(header),
    ...messages.map((message) => JSON.stringify(traceMessageRecord(message))),
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

function traceMessageRecord(message: JsonValue) {
  const record = jsonObject(message);
  const info = jsonObject(record?.info);
  if (!record || !info) {
    throw new Error("opencode export returned a message without info.");
  }
  const parts = jsonArray(record.parts) ?? [];
  const trace: JsonObject = {
    type: OPENCODE_MESSAGE_RECORD,
    info: pick(info, [
      "id",
      "sessionID",
      "role",
      "time",
      "error",
      "agent",
      "modelID",
      "providerID",
    ]),
    parts: parts.flatMap((part) => {
      const object = jsonObject(part);
      return object ? [tracePart(object)] : [];
    }),
  };
  return trace;
}

function tracePart(part: JsonObject) {
  const common = pick(part, ["id", "type"]);
  switch (part.type) {
    case "text":
      return { ...common, ...pick(part, ["text", "ignored", "synthetic"]) };
    case "reasoning":
      return { ...common, ...pick(part, ["text", "time"]) };
    case "tool": {
      const state = jsonObject(part.state);
      return {
        ...common,
        ...pick(part, ["tool", "callID"]),
        state: state
          ? pick(state, ["status", "input", "output", "error", "title", "time"])
          : {},
      };
    }
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

function pick(value: JsonObject, keys: readonly string[]) {
  const picked: JsonObject = {};
  for (const key of keys) {
    const entry = value[key];
    if (entry !== undefined) picked[key] = entry;
  }
  return picked;
}
