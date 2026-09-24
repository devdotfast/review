// The PostHog error-tracking twin of a sanitized review_client_error. It reuses
// the already cleaned message, the digest and the bundle-relative frames, so it
// adds nothing the allowlist has not checked.

import { type JsonObject, jsonString } from "@dev.fast/json";

import { BUNDLE_FRAME_SEPARATOR } from "./ui-telemetry-events";

const FRAME_PATTERN = /^(.+):(\d+):(\d+)$/;

/** Processes that run on Node rather than in a browser renderer. */
const NODE_PROCESSES = new Set(["main", "server"]);

export function exceptionProperties(
  properties: JsonObject,
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
    .flatMap((frame) => parseFrame(frame, platform));

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

  return hash === undefined
    ? exception
    : { ...exception, $exception_fingerprint: hash };
}

function parseFrame(frame: string, platform: string): JsonObject[] {
  const match = FRAME_PATTERN.exec(frame);

  if (!match) return [];

  return [
    {
      platform,
      filename: match[1],
      lineno: Number(match[2]),
      colno: Number(match[3]),
      function: "?",
      in_app: true,
    },
  ];
}
