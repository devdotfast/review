import {
  type JsonValue,
  isJsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import pino from "pino";
import pretty from "pino-pretty";

import type { ReviewLifecycleError, ReviewLifecycleEvent } from "./types";

export type ReviewLogFormat = "ndjson" | "pretty";

// This is the only presentation choice in the Review logging pipeline.
export const DEFAULT_REVIEW_LOG_FORMAT: ReviewLogFormat = "ndjson";

export interface ReviewLogger {
  event(event: ReviewLifecycleEvent): void;
}

export function createReviewLogger(input: {
  output: NodeJS.WritableStream;
  format?: ReviewLogFormat;
  colorize?: boolean;
}): ReviewLogger {
  const format = input.format ?? DEFAULT_REVIEW_LOG_FORMAT;
  const destination =
    format === "pretty"
      ? pretty({
          destination: input.output,
          sync: true,
          colorize:
            input.colorize ??
            Boolean((input.output as NodeJS.WriteStream).isTTY),
          translateTime: false,
          singleLine: true,
          messageFormat: "{event}",
          ignore: "pid,hostname,time,event",
        })
      : input.output;
  const logger = pino(
    {
      base: null,
      timestamp: false,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    destination,
  );

  return {
    event(event) {
      if (event.event === "diagnostic") {
        const { level, ...record } = event;
        logger[level](record);
        return;
      }
      if (event.event === "error") {
        logger.error(event);
        return;
      }
      logger.info(event);
    },
  };
}

const defaultLoggers = new WeakMap<NodeJS.WritableStream, ReviewLogger>();

export function emitReviewEvent(
  output: NodeJS.WritableStream,
  event: ReviewLifecycleEvent,
): void {
  let logger = defaultLoggers.get(output);
  if (!logger) {
    logger = createReviewLogger({ output });
    defaultLoggers.set(output, logger);
  }
  logger.event(event);
}

export function serializeReviewError(cause: unknown): ReviewLifecycleError {
  // A thrown object is read as the JSON record it is about to be logged as;
  // each field the record keeps is decoded on its own below.
  const fields = isJsonObject(cause) ? cause : undefined;
  const stack = jsonString(fields?.stack);
  const component = jsonString(fields?.component);
  const propertyPath = jsonString(fields?.propertyPath);
  return {
    name:
      cause instanceof Error
        ? cause.name
        : (jsonString(fields?.name) ?? "Error"),
    message:
      cause instanceof Error
        ? cause.message
        : (jsonString(fields?.message) ?? String(cause)),
    ...(stack === undefined ? {} : { stack }),
    ...(component === undefined ? {} : { component }),
    ...(propertyPath === undefined ? {} : { propertyPath }),
    ...(fields && "expected" in fields
      ? { expected: jsonSafeValue(fields.expected) }
      : {}),
    ...(fields && "received" in fields
      ? { received: jsonSafeValue(fields.received) }
      : {}),
  };
}

/** Round-trip through JSON so a value that cannot serialize still logs. */
function jsonSafeValue(value: JsonValue): JsonValue {
  try {
    return parseJsonText(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
