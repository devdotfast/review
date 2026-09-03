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

/** The fields a thrown non-Error value may carry that the log record keeps. */
interface ThrownValueFields {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  component?: unknown;
  propertyPath?: unknown;
  expected?: unknown;
  received?: unknown;
}

export function serializeReviewError(error: unknown): ReviewLifecycleError {
  // SAFETY: every field is optional and re-checked with typeof/in below, so
  // any non-null object satisfies the shape.
  const value =
    error && typeof error === "object" ? (error as ThrownValueFields) : null;
  return {
    name:
      error instanceof Error
        ? error.name
        : typeof value?.name === "string"
          ? value.name
          : "Error",
    message:
      error instanceof Error
        ? error.message
        : typeof value?.message === "string"
          ? value.message
          : String(error),
    ...(typeof value?.stack === "string" ? { stack: value.stack } : {}),
    ...(typeof value?.component === "string"
      ? { component: value.component }
      : {}),
    ...(typeof value?.propertyPath === "string"
      ? { propertyPath: value.propertyPath }
      : {}),
    ...(value && "expected" in value
      ? { expected: jsonSafeValue(value.expected) }
      : {}),
    ...(value && "received" in value
      ? { received: jsonSafeValue(value.received) }
      : {}),
  };
}

function jsonSafeValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
