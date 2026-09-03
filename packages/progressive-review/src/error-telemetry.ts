// Turns a raw JavaScript error into reportable telemetry properties.
//
// This module is the only place that sees raw error text on the way to PostHog.
// Callers hand it the `error` envelope of a loopback telemetry request, and it
// returns four things: the class name, the message with paths, addresses and
// secrets replaced by markers, a digest of the original message, and stack
// frames rewritten to start inside the shipped Review bundle.
//
// The message is cleaned with a port of VS Code's cleaner (telemetry-clean-text
// .ts) rather than a rule of our own, because that one is proven at scale in the
// product this is a fork of.
//
// ui-telemetry-events.ts re-checks the result independently — the frames
// against a bundle-path pattern, the message against the same secret shapes plus
// a refusal of any surviving path separator — so a bug here cannot by itself
// leak a path.

import { createHash } from "node:crypto";

import type { JsonObject } from "@dev.fast/review-protocol";

import { cleanTelemetryText } from "./telemetry-clean-text";
import {
  BUNDLE_FRAME_PATTERN,
  BUNDLE_FRAME_SEPARATOR,
  isReportableCleanedMessage,
} from "./ui-telemetry-events";

/** The raw error envelope a client may attach beside its event properties. */
export interface RawErrorReport {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
}

export interface DerivedErrorTelemetryProperties {
  error_name?: string;
  message?: string;
  message_hash?: string;
  frames?: string;
}

/**
 * Errors whose message quotes the document being checked. A review tool runs
 * authored prose through schemas, so these carry review content by design —
 * unlike an editor, which mostly reports on files. Keep the class, the digest
 * and the frames; drop the message. VS Code drops file-operation errors and
 * errors carrying a system code for the same reason.
 */
const SCHEMA_ERROR_NAMES = new Set(["ZodError", "ValidationError"]);

const MESSAGE_HASH_LENGTH = 16;
const MAX_FRAMES = 10;
const MAX_STACK_LENGTH = 16_384;
const MAX_ERROR_NAME_LENGTH = 40;
const ERROR_NAME_PATTERN = /^[A-Za-z0-9_$-]+$/;

/**
 * Path segments that exist only inside the shipped bundle. A frame keeps the
 * text that follows the LAST occurrence of one of these and discards everything
 * before it, which is what removes the absolute prefix. A frame with no such
 * segment is not ours, so it is dropped.
 */
const BUNDLE_ANCHORS = ["/out/", "/assets/", "/review-runtime/"];

/** `at fn (url:line:col)`, `at url:line:col`, and the bare `url:line:col`. */
const STACK_FRAME_PATTERN = /(?:\(|\bat\s+|^\s*)([^()\s]+?):(\d+):(\d+)\)?\s*$/;

export function deriveErrorTelemetryProperties(
  raw: unknown,
): DerivedErrorTelemetryProperties {
  const derived: DerivedErrorTelemetryProperties = {};
  try {
    if (!raw || typeof raw !== "object") return derived;
    const report = raw as RawErrorReport;

    const name = report.name;
    if (
      typeof name === "string" &&
      name.length > 0 &&
      name.length <= MAX_ERROR_NAME_LENGTH &&
      ERROR_NAME_PATTERN.test(name)
    ) {
      derived.error_name = name;
    }

    const message = report.message;
    if (typeof message === "string" && message.length > 0) {
      // The digest goes on every report, cleaned message or not. It is what
      // groups the reports whose message does not survive the checks below.
      derived.message_hash = hashErrorMessage(message);
      if (!SCHEMA_ERROR_NAMES.has(derived.error_name ?? "")) {
        const cleaned = cleanTelemetryText(message, NO_DELETED_DIRECTORIES);
        // Ask the allowlist's own check before sending. Failing here rather
        // than there keeps a message that the cleaner could not finish out of
        // the payload entirely, instead of relying on the later gate.
        if (isReportableCleanedMessage(cleaned)) derived.message = cleaned;
      }
    }

    const frames = packBundleFrames(report.stack);
    if (frames) derived.frames = frames;
  } catch {
    // Telemetry must never break the request that carried it.
  }
  return derived;
}

/**
 * Properties only this module may produce, because each is a claim about work
 * the server did that the allowlist cannot check for itself: whether a message
 * was cleaned, and whether a digest or a frame list really came from this
 * error. A client that sent one directly would reach the allowlist with no
 * cleaning behind it.
 *
 * `error_name` is deliberately absent. The allowlist caps it at 40 identifier
 * characters, which makes it safe whoever sends it, and `bug_report_send_failed`
 * sends it with no error envelope.
 */
const SERVER_DERIVED_PROPERTIES = [
  "message",
  "message_hash",
  "frames",
] as const;

/**
 * Merge a client's event properties with the ones derived from its raw error.
 * This is the only supported way to build an error-bearing telemetry payload:
 * it removes any server-derived property the client tried to assert before
 * adding the real ones.
 */
export function mergeErrorTelemetryProperties(
  clientProperties: JsonObject,
  rawError: unknown,
): JsonObject {
  const merged = { ...clientProperties };
  for (const key of SERVER_DERIVED_PROPERTIES) delete merged[key];
  if (rawError) Object.assign(merged, deriveErrorTelemetryProperties(rawError));
  return merged;
}

/**
 * Review deliberately gives the cleaner NO directories to delete, which is the
 * one place its configuration differs from VS Code's.
 *
 * VS Code passes five — its app root, extensions path, user data path, home
 * directory and temporary directory — and deletes each prefix outright so the
 * remainder reads as a relative path. That is right for a stack trace, where
 * the remainder is VS Code's own file. It is wrong here: a path under the home
 * directory then keeps everything after it, so
 * `/Users/you/work/acme-repo/plan.md` would be sent as
 * `/work/acme-repo/plan.md` — the repository name intact. A review tool cannot
 * disclose that.
 *
 * With no directories to delete, the cleaner's overlap check never fires and
 * the whole path is replaced by a marker instead, which is what we want. Frames
 * are unaffected: they are anchored on the bundle directory separately.
 */
const NO_DELETED_DIRECTORIES: RegExp[] = [];

/**
 * A stable fingerprint of the message. Two reports with the same digest had the
 * same cause; the digest itself reveals nothing, because it is one-way and the
 * message is never sent alongside it.
 */
export function hashErrorMessage(message: string): string {
  return createHash("sha256")
    .update(message, "utf8")
    .digest("hex")
    .slice(0, MESSAGE_HASH_LENGTH);
}

/**
 * Rewrite a stack into bundle-relative `file:line:col` frames joined by "|".
 * Returns undefined when no frame resolves inside the bundle.
 */
export function packBundleFrames(stack: unknown): string | undefined {
  const text = Array.isArray(stack)
    ? stack.join("\n")
    : typeof stack === "string"
      ? stack
      : undefined;
  if (!text) return undefined;

  const frames: string[] = [];
  for (const line of text.slice(0, MAX_STACK_LENGTH).split("\n")) {
    const match = STACK_FRAME_PATTERN.exec(line);
    if (!match) continue;
    const file = bundleRelativePath(match[1]);
    if (!file) continue;
    const frame = `${file}:${match[2]}:${match[3]}`;
    // A user directory can be called "out" too, so anchoring alone is not
    // enough: the result must also start inside a known bundle directory.
    if (!BUNDLE_FRAME_PATTERN.test(frame)) continue;
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.length > 0 ? frames.join(BUNDLE_FRAME_SEPARATOR) : undefined;
}

function bundleRelativePath(location: string): string | undefined {
  // Drop a query or fragment first: either can carry arbitrary text, and a
  // cache-busting query is common on the canvas bundle.
  const clean = location.split(/[?#]/, 1)[0];
  let cut = -1;
  let anchorLength = 0;
  for (const anchor of BUNDLE_ANCHORS) {
    const index = clean.lastIndexOf(anchor);
    if (index > cut) {
      cut = index;
      anchorLength = anchor.length;
    }
  }
  if (cut < 0) return undefined;
  const relative = clean.slice(cut + anchorLength);
  // "/review-runtime/" and "/assets/" name the directory the frame lives in, so
  // put it back; "/out/" is a build directory and is not part of the path we
  // report.
  const prefix = clean.slice(cut + 1, cut + anchorLength);
  const path = prefix === "out/" ? relative : `${prefix}${relative}`;
  return path.length > 0 ? path : undefined;
}
