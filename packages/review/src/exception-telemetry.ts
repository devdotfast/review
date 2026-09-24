// The PostHog error-tracking twin of a sanitized review_client_error. It reuses
// the already cleaned message, the digest and the bundle-relative frames, so it
// adds nothing the allowlist has not checked.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type JsonObject,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/json";

import { BUNDLE_FRAME_SEPARATOR } from "./ui-telemetry-events";

const FRAME_PATTERN = /^(.+):(\d+):(\d+)$/;

/** Processes that run on Node rather than in a browser renderer. */
const NODE_PROCESSES = new Set(["main", "server"]);

/** Bundle path to the PostHog chunk ID of its uploaded source map. */
export type ChunkIds = ReadonlyMap<string, string>;

/** Written by apps/review-desktop/scripts/upload-source-maps.mjs. */
const CHUNK_ID_MANIFEST = "review-chunk-ids.json";

const CHUNK_ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * Read the chunk IDs of a released app. The server entry is
 * `<app>/review-runtime/dist/server/desktop-host.js` and the manifest sits in
 * `<app>/out`. Source builds and the standalone CLI have none.
 */
export function readChunkIds(serverEntry: string | undefined): ChunkIds {
  if (!serverEntry) return new Map();

  try {
    const manifest = jsonObject(
      parseJsonText(
        readFileSync(
          path.resolve(
            path.dirname(serverEntry),
            "../../../out",
            CHUNK_ID_MANIFEST,
          ),
          "utf8",
        ),
      ),
    );

    return new Map(
      Object.entries(manifest ?? {}).flatMap(([file, id]) => {
        const chunkId = jsonString(id);

        return chunkId && CHUNK_ID_PATTERN.test(chunkId)
          ? [[file, chunkId] as const]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}

export function exceptionProperties(
  properties: JsonObject,
  chunkIds: ChunkIds = new Map(),
): JsonObject | undefined {
  const type = jsonString(properties.error_name);
  const hash = jsonString(properties.message_hash);

  if (type === undefined && hash === undefined) return undefined;

  const platform = NODE_PROCESSES.has(
    jsonString(properties.error_process) ?? "",
  )
    ? "node:javascript"
    : "web:javascript";

  const frames = (jsonString(properties.frames) ?? "")
    .split(BUNDLE_FRAME_SEPARATOR)
    .flatMap((frame) => parseFrame(frame, platform, chunkIds));

  const exception = {
    $exception_level: "error",
    $exception_list: [
      {
        type: type ?? "Error",
        value:
          jsonString(properties.message) ??
          (hash ? `[message withheld] ${hash}` : "[message withheld]"),
        mechanism: { handled: true, synthetic: false },
        stacktrace: { type: "raw", frames },
      },
    ],
  } satisfies JsonObject;

  // PostHog groups a stack it can resolve by its source frames, which tells
  // apart different bugs that share one message. Only an unresolvable stack
  // falls back to the message digest.
  const resolvable =
    frames.length > 0 && frames.every((frame) => frame.chunk_id);

  return hash === undefined || resolvable
    ? exception
    : { ...exception, $exception_fingerprint: hash };
}

function parseFrame(
  frame: string,
  platform: string,
  chunkIds: ChunkIds,
): JsonObject[] {
  const match = FRAME_PATTERN.exec(frame);

  if (!match) return [];

  const parsed: JsonObject = {
    platform,
    filename: match[1],
    lineno: Number(match[2]),
    colno: Number(match[3]),
    function: "?",
    in_app: true,
  };

  const chunkId = chunkIds.get(match[1]);

  if (chunkId) parsed.chunk_id = chunkId;

  return [parsed];
}
