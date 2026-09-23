import {
  type JsonValue,
  isJsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
import pino from "pino";
import pretty from "pino-pretty";

export type WhiteboardLogFormat = "ndjson" | "pretty";

export type WhiteboardLifecyclePhaseName = "review_document" | "server";

export interface WhiteboardLifecycleError {
  name: string;
  message: string;
  stack?: string;
  component?: string;
  propertyPath?: string;
  expected?: unknown;
  received?: unknown;
}

export type WhiteboardLifecycleEvent =
  | {
      event: "start";
      cliPath: string;
      cliName: string;
      cliVersion: string;
      provenance: "workspace" | "installed";
      source: string;
      args: string[];
      base: string;
      head: string;
      repo?: string;
      pullRequest?: number;
    }
  | {
      event: "phase";
      name: WhiteboardLifecyclePhaseName;
      status: "running" | "complete";
    }
  | {
      event: "ready";
      url: string;
      document: string;
      headCheckout?: string;
    }
  | {
      event: "diagnostic";
      level: "info" | "warn" | "error";
      origin: "review";
      message: string;
      error?: WhiteboardLifecycleError;
    }
  | { event: "dismissed"; reason: "canvas_closed" }
  | {
      event: "error";
      error: WhiteboardLifecycleError;
    };

// This is the only presentation choice in the Review logging pipeline.
export const DEFAULT_WHITEBOARD_LOG_FORMAT: WhiteboardLogFormat = "ndjson";

export interface WhiteboardLogger {
  event(event: WhiteboardLifecycleEvent): void;
}

export function createWhiteboardLogger(input: {
  output: NodeJS.WritableStream;
  format?: WhiteboardLogFormat;
  colorize?: boolean;
}): WhiteboardLogger {
  const format = input.format ?? DEFAULT_WHITEBOARD_LOG_FORMAT;

  const destination =
    format === "pretty"
      ? pretty({
          destination: input.output,
          sync: true,
          colorize:
            input.colorize ??
            ("isTTY" in input.output && Boolean(input.output.isTTY)),
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

const defaultLoggers = new WeakMap<NodeJS.WritableStream, WhiteboardLogger>();

export function emitWhiteboardEvent(
  output: NodeJS.WritableStream,
  event: WhiteboardLifecycleEvent,
): void {
  let logger = defaultLoggers.get(output);

  if (!logger) {
    logger = createWhiteboardLogger({ output });
    defaultLoggers.set(output, logger);
  }

  logger.event(event);
}

export function serializeWhiteboardError(
  cause: unknown,
): WhiteboardLifecycleError {
  // A thrown object is read as the JSON record it is about to be logged as;
  // each field the record keeps is decoded on its own below.
  const fields = isJsonObject(cause) ? cause : undefined;
  const stack = jsonString(fields?.stack);
  const component = jsonString(fields?.component);
  const propertyPath = jsonString(fields?.propertyPath);

  const error: WhiteboardLifecycleError = {
    name:
      cause instanceof Error
        ? cause.name
        : (jsonString(fields?.name) ?? "Error"),
    message:
      cause instanceof Error
        ? cause.message
        : (jsonString(fields?.message) ?? String(cause)),
  };

  if (stack !== undefined) error.stack = stack;

  if (component !== undefined) error.component = component;

  if (propertyPath !== undefined) error.propertyPath = propertyPath;

  if (fields && "expected" in fields) {
    error.expected = jsonSafeValue(fields.expected);
  }

  if (fields && "received" in fields) {
    error.received = jsonSafeValue(fields.received);
  }

  return error;
}

/** Round-trip through JSON so a value that cannot serialize still logs. */
function jsonSafeValue(value: JsonValue): JsonValue {
  try {
    return parseJsonText(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
