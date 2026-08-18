// Contract for UI-originated telemetry events.
//
// Privacy invariant: telemetry must never carry user content — no review
// prose, code, symbol names, file paths, locators, quotes, or node labels. The
// server validates every incoming UI event against this allowlist and DROPS
// anything not listed here: unknown events, unknown property keys, values
// outside an enum, non-finite numbers, or oversized values. Adding a property
// therefore requires extending this table, which is the intended review point
// for privacy.
//
// Error reports are the one place free text is allowed, and it is bounded on
// both sides. A raw error reaches the local server in the request's `error`
// envelope, never in `properties`. The server cleans the message with a port of
// VS Code's cleaner, which replaces paths, addresses and secrets with markers,
// and this file re-checks the result with `isReportableCleanedMessage` before
// accepting the property. Either the cleaner finished the job or only the
// digest goes; a wrong producer cannot put raw text on the wire through here.

import {
  containsFilePathShape,
  hasPossibleUserInfo,
} from "./telemetry-clean-text";

/** Property value validators: an enum of allowed strings, or a scalar type. */
export type UiTelemetryPropertySpec =
  | readonly string[]
  | "number"
  | "boolean"
  | "opaque_id"
  // A short identifier-like string (e.g. a JS error class name). The only
  // free-form value allowed anywhere, still length- and charset-capped.
  | "enum_free_short"
  // A truncated SHA-256 digest. Groups identical error messages without ever
  // carrying the message itself.
  | "hash_hex"
  // Stack frames that resolve inside the shipped bundle, separated by "|".
  // Every frame is re-checked here against BUNDLE_FRAME_PATTERN, so a bug in
  // the producer cannot smuggle a user path through.
  | "bundle_frames"
  // An error message that has been through the cleaner. Re-checked here against
  // the same secret shapes, plus a refusal of any surviving path separator.
  | "cleaned_message";

export interface UiTelemetryEventSpec {
  /** PostHog event name (already namespaced). */
  readonly event: string;
  readonly properties: Readonly<Record<string, UiTelemetryPropertySpec>>;
}

const PEEK_VIA = ["prose_link", "diagram", "marker", "map", "db_lens"] as const;
export const LSP_FEATURE = [
  "hover",
  "goto_definition",
  "peek_definition",
  "goto_type_definition",
  "goto_implementation",
  "references",
  "rename",
  "format",
  "code_action",
  "symbol_search",
] as const;
export const LSP_VIA = ["command", "mouse"] as const;
export const LSP_EDITOR_KIND = ["files_tab", "inline_peek", "diff"] as const;
export const LSP_LANGUAGE = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "swift",
  "csharp",
  "json",
  "css",
  "html",
  "markdown",
  "yaml",
  "toml",
  "shell",
  "sql",
  "other",
] as const;
export const LS_GROUP = ["python", "go", "rust", "swift", "csharp"] as const;
export const EXTENSION_ID = [
  "vscodevim.vim",
  "tuttieee.emacs-mcx",
  "ms-python.python",
  "astral-sh.ty",
  "charliermarsh.ruff",
  "golang.go",
  "rust-lang.rust-analyzer",
  "swiftlang.swift-vscode",
  "llvm-vs-code-extensions.lldb-dap",
  "muhammad-sammy.csharp",
  "ms-dotnettools.vscode-dotnet-runtime",
] as const;
export const EXTENSION_TRIGGER = [
  "user",
  "auto_upgrade",
  "startup_seed",
  "keymap",
  "rollback",
] as const;
export const EXTENSION_INSTALL_PHASE = ["download", "install"] as const;
export const SETTING_NAME = [
  "telemetry_enabled",
  "keymap",
  "dismissed_retention_days",
  "software_map_enabled",
] as const;
export const REVIEW_OPENED_VIA = ["home", "cli", "other"] as const;
const REVIEW_DISMISSED_VIA = ["review_topbar", "home"] as const;
// "open" is the implicit undo: opening a dismissed review brings it back.
const REVIEW_RESTORED_VIA = ["home", "open"] as const;
const PEEK_ROOT_KIND = ["symbol", "declaration", "range"] as const;
const MAP_LEVEL = ["system", "container", "component", "code"] as const;
const THREAD_INTENT = ["comment", "ask-agent"] as const;
const NEW_ASK_VIA = ["topbar", "threads_panel"] as const;
const SOURCE_TREE_OPENED_VIA = ["topbar", "home"] as const;
const THREAD_RESOLUTION_KIND = ["comment"] as const;
const TAB = ["review", "commits", "map", "files", "trace"] as const;
const COMMIT_DIFF_VIA = ["row", "file", "footer"] as const;
export const CLIENT_ERROR_SOURCE = [
  "window",
  "worker",
  "fetch",
  "render",
  "document",
  "renderer_unexpected",
  "main_unexpected",
  "bootstrap",
] as const;
export const ERROR_PROCESS = ["main", "renderer", "canvas", "server"] as const;

/**
 * Directories that exist only in the shipped Review bundle. A stack frame is
 * reportable when — and only when — it has already been rewritten to start at
 * one of these, which is what strips the user's home directory off the front.
 * See error-telemetry.ts; this table re-checks the result independently.
 */
export const BUNDLE_FRAME_ROOTS = [
  "vs/review/",
  "vs/workbench/",
  "vs/platform/",
  "vs/base/",
  "vs/code/",
  "vs/editor/",
  "assets/",
  "review-runtime/",
] as const;

/**
 * The Electron entry files, which sit beside those directories rather than
 * inside one. A crash before the app can start lands here and nowhere else, so
 * without this list the report that matters most carries no location at all.
 * The list is closed for the same reason the directories are.
 */
export const BUNDLE_FRAME_ENTRY_FILES = [
  "main.js",
  "cli.js",
  "bootstrap-cli.js",
  "bootstrap-esm.js",
  "bootstrap-fork.js",
  "bootstrap-meta.js",
  "bootstrap-node.js",
] as const;

/**
 * One normalized stack frame: a bundle-relative path, then `:line:col`. The
 * character class is deliberately narrow — anything outside it could carry user
 * content — and there is no function name, because the file already identifies
 * the frame and a minified name adds surface for nothing.
 */
const escapeForPattern = (value: string): string =>
  value.replaceAll(".", "\\.").replaceAll("/", "\\/");
export const BUNDLE_FRAME_PATTERN = new RegExp(
  "^(?:" +
    [
      `(?:${BUNDLE_FRAME_ROOTS.map(escapeForPattern).join("|")})[A-Za-z0-9_./-]*`,
      `(?:${BUNDLE_FRAME_ENTRY_FILES.map(escapeForPattern).join("|")})`,
    ].join("|") +
    "):\\d{1,9}:\\d{1,9}$",
);
export const BUNDLE_FRAME_SEPARATOR = "|";
const MAX_BUNDLE_FRAMES = 10;
const MAX_BUNDLE_FRAMES_LENGTH = 1_024;
const HASH_HEX_PATTERN = /^[0-9a-f]{16}$/;
const MAX_CLEANED_MESSAGE_LENGTH = 300;
/** A marker the cleaner writes, e.g. `<REDACTED: user-file-path>`. */
const REDACTION_MARKER_PATTERN = /<REDACTED: [A-Za-z][A-Za-z0-9 -]*>/g;

/**
 * Header the canvas app attaches to review API requests so server-side events
 * can share the UI session id. The CORS preflight allowlist in
 * server/hono-http.ts must permit every header named here — the canvas runs on
 * a vscode-file:// origin, so a header missing from that list fails the
 * preflight and takes the whole request down with it.
 */
export const REVIEW_APP_SESSION_ID_HEADER = "x-review-app-session-id";

export const UI_TELEMETRY_EVENTS = {
  app_opened: {
    event: "review_app_opened",
    properties: {},
  },
  tab_viewed: {
    event: "review_tab_viewed",
    properties: { tab: TAB },
  },
  peek_opened: {
    event: "review_peek_opened",
    properties: { via: PEEK_VIA },
  },
  peek_resolve_failed: {
    event: "review_peek_resolve_failed",
    properties: { root_kind: PEEK_ROOT_KIND },
  },
  peek_resolved: {
    event: "review_peek_resolved",
    properties: { root_kind: PEEK_ROOT_KIND },
  },
  tour_started: {
    event: "review_tour_started",
    properties: { steps: "number" },
  },
  tour_completed: {
    event: "review_tour_completed",
    properties: { steps: "number" },
  },
  map_expanded: {
    event: "review_map_expanded",
    properties: { level: MAP_LEVEL },
  },
  commit_expanded: {
    event: "review_commit_expanded",
    properties: { expanded: "boolean" },
  },
  commit_diff_opened: {
    event: "review_commit_diff_opened",
    properties: { via: COMMIT_DIFF_VIA },
  },
  thread_draft_opened: {
    event: "review_thread_draft_opened",
    properties: { intent: THREAD_INTENT },
  },
  threads_opened: {
    event: "review_threads_opened",
    properties: { thread_count: "number" },
  },
  new_ask_opened: {
    event: "review_new_ask_opened",
    properties: { via: NEW_ASK_VIA },
  },
  source_tree_opened: {
    event: "review_source_tree_opened",
    properties: { via: SOURCE_TREE_OPENED_VIA },
  },
  comment_created: {
    event: "review_comment_created",
    properties: { is_reply: "boolean" },
  },
  agent_run_started: {
    event: "review_agent_run_started",
    properties: {},
  },
  thread_resolved: {
    event: "review_thread_resolved",
    properties: { kind: THREAD_RESOLUTION_KIND },
  },
  // Dismissal replaced the old reject decision: the reader is finished with the
  // review, whether or not they liked the change.
  review_dismissed: {
    event: "review_review_dismissed",
    properties: { via: REVIEW_DISMISSED_VIA },
  },
  // The undo. It says the reader was not finished after all.
  review_restored: {
    event: "review_review_restored",
    properties: { via: REVIEW_RESTORED_VIA },
  },
  review_submitted: {
    event: "review_review_submitted",
    properties: {
      decision: ["approve", "request-changes"],
      comment_count: "number",
    },
  },
  client_error: {
    event: "review_client_error",
    // error_name is a JS error class name (TypeError, …), never a message.
    // component is a stable, package-owned Review component or helper name,
    // never an authored value or property path.
    // message, message_hash and frames are derived server-side from the raw
    // error, which travels in the request's `error` envelope and never in these
    // properties.
    // The property is error_source, not source: captureUiEvent stamps
    // source: "review_app" on every UI event, and a property of the same name
    // silently overwrites it.
    properties: {
      error_source: CLIENT_ERROR_SOURCE,
      error_process: ERROR_PROCESS,
      error_name: "enum_free_short",
      component: "enum_free_short",
      message: "cleaned_message",
      message_hash: "hash_hex",
      frames: "bundle_frames",
    },
  },
  lsp_used: {
    event: "review_lsp_used",
    properties: {
      feature: LSP_FEATURE,
      via: LSP_VIA,
      language: LSP_LANGUAGE,
      editor_kind: LSP_EDITOR_KIND,
    },
  },
  ls_activated: {
    event: "review_ls_activated",
    properties: { group: LS_GROUP, ok: "boolean" },
  },
  extension_installed: {
    event: "review_extension_installed",
    properties: {
      extension_id: EXTENSION_ID,
      trigger: EXTENSION_TRIGGER,
      cached: "boolean",
      duration_ms: "number",
    },
  },
  extension_install_failed: {
    event: "review_extension_install_failed",
    properties: {
      extension_id: EXTENSION_ID,
      trigger: EXTENSION_TRIGGER,
      phase: EXTENSION_INSTALL_PHASE,
    },
  },
  extension_enabled: {
    event: "review_extension_enabled",
    properties: { extension_id: EXTENSION_ID, trigger: EXTENSION_TRIGGER },
  },
  extension_disabled: {
    event: "review_extension_disabled",
    properties: { extension_id: EXTENSION_ID, trigger: EXTENSION_TRIGGER },
  },
  extension_uninstalled: {
    event: "review_extension_uninstalled",
    properties: { extension_id: EXTENSION_ID, trigger: EXTENSION_TRIGGER },
  },
  tour_step_advanced: {
    event: "review_tour_step_advanced",
    properties: { step: "number", steps: "number" },
  },
  tour_abandoned: {
    event: "review_tour_abandoned",
    properties: { step: "number", steps: "number" },
  },
  bug_report_dialog_opened: {
    event: "review_bug_report_dialog_opened",
    properties: {},
  },
  bug_report_cancelled: {
    event: "review_bug_report_cancelled",
    properties: {},
  },
  bug_report_send_failed: {
    event: "review_bug_report_send_failed",
    properties: { error_name: "enum_free_short" },
  },
  setting_changed: {
    event: "review_setting_changed",
    properties: { setting: SETTING_NAME, enabled: "boolean" },
  },
  review_opened: {
    event: "review_review_opened",
    properties: { via: REVIEW_OPENED_VIA },
  },
  review_presented: {
    event: "review_review_presented",
    properties: {},
  },
  home_empty_state_viewed: {
    event: "review_home_empty_state_viewed",
    properties: {},
  },
} as const satisfies Record<
  string,
  { event: string; properties: Record<string, UiTelemetryPropertySpec> }
>;

export type UiTelemetryEventName = keyof typeof UI_TELEMETRY_EVENTS;

const MAX_FREE_STRING_LENGTH = 40;
const FREE_STRING_PATTERN = /^[A-Za-z0-9_$-]+$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const COMMON_PROPERTIES = {
  app_session_id: "opaque_id",
} as const satisfies Record<string, UiTelemetryPropertySpec>;

/**
 * Validate a raw UI event payload against the allowlist. Returns the PostHog
 * event name plus only the sanctioned properties, or null when the event
 * itself is unknown. Unknown keys and invalid values are silently dropped —
 * never forwarded.
 */
export function sanitizeUiTelemetryEvent(input: {
  name: unknown;
  properties?: unknown;
}): {
  event: string;
  properties: Record<string, string | number | boolean>;
} | null {
  if (typeof input.name !== "string") return null;
  const spec = (
    UI_TELEMETRY_EVENTS as Record<string, UiTelemetryEventSpec | undefined>
  )[input.name];
  if (!spec) return null;

  const raw =
    input.properties && typeof input.properties === "object"
      ? (input.properties as Record<string, unknown>)
      : {};
  const properties: Record<string, string | number | boolean> = {};
  const propertySpecs: Record<string, UiTelemetryPropertySpec> = {
    ...COMMON_PROPERTIES,
    ...spec.properties,
  };
  for (const [key, propSpec] of Object.entries(propertySpecs)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (propSpec === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        properties[key] = value;
      }
      continue;
    }
    if (propSpec === "boolean") {
      if (typeof value === "boolean") properties[key] = value;
      continue;
    }
    if (propSpec === "opaque_id") {
      if (isValidReviewAppSessionId(value)) {
        properties[key] = value;
      }
      continue;
    }
    if (propSpec === "enum_free_short") {
      if (
        typeof value === "string" &&
        value.length <= MAX_FREE_STRING_LENGTH &&
        FREE_STRING_PATTERN.test(value)
      ) {
        properties[key] = value;
      }
      continue;
    }
    if (propSpec === "hash_hex") {
      if (typeof value === "string" && HASH_HEX_PATTERN.test(value)) {
        properties[key] = value;
      }
      continue;
    }
    if (propSpec === "bundle_frames") {
      const frames = sanitizeBundleFrames(value);
      if (frames) properties[key] = frames;
      continue;
    }
    if (propSpec === "cleaned_message") {
      if (typeof value === "string" && isReportableCleanedMessage(value)) {
        properties[key] = value;
      }
      continue;
    }
    if (Array.isArray(propSpec) && typeof value === "string") {
      if ((propSpec as readonly string[]).includes(value)) {
        properties[key] = value;
      }
    }
  }
  return { event: spec.event, properties };
}

/**
 * The independent second check on a cleaned error message.
 *
 * It never repairs the message. Either the cleaner finished the job or the
 * message is dropped and only the digest goes, so a bug in the cleaner cannot
 * by itself put a path on the wire.
 *
 * The path rule is the load-bearing one: the cleaner replaces every path-shaped
 * run with a marker, so a surviving path shape means something got past it.
 */
export function isReportableCleanedMessage(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CLEANED_MESSAGE_LENGTH) {
    return false;
  }
  // The cleaner's own markers are known-safe output, and several of them name
  // the thing they replaced — "<REDACTED: GitHub Token>" holds the word "token"
  // and would trip the secret rule below. So the checks apply to what is left
  // once the markers are removed. The marker shape is deliberately narrow, so a
  // producer cannot hide content inside a marker of its own.
  const remainder = value.replaceAll(REDACTION_MARKER_PATTERN, " ");
  return !containsFilePathShape(remainder) && !hasPossibleUserInfo(remainder);
}

/**
 * Keep only the frames that match BUNDLE_FRAME_PATTERN. Frames arrive already
 * normalized; this is the independent second check, so it never repairs a frame
 * — it drops it. Returns undefined when nothing survives.
 */
function sanitizeBundleFrames(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const kept: string[] = [];
  let length = 0;
  for (const frame of value.split(BUNDLE_FRAME_SEPARATOR)) {
    if (!BUNDLE_FRAME_PATTERN.test(frame)) continue;
    const next = length + frame.length + (kept.length > 0 ? 1 : 0);
    if (next > MAX_BUNDLE_FRAMES_LENGTH) break;
    kept.push(frame);
    length = next;
    if (kept.length >= MAX_BUNDLE_FRAMES) break;
  }
  return kept.length > 0 ? kept.join(BUNDLE_FRAME_SEPARATOR) : undefined;
}

export function isValidReviewAppSessionId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}
