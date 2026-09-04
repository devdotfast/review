import { describe, expect, it } from "vitest";

import { sanitizeUiTelemetryEvent } from "./ui-telemetry-events";

describe("sanitizeUiTelemetryEvent", () => {
  it("preserves privacy-safe Review authoring error dimensions", () => {
    expect(
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: {
          error_source: "document",
          error_process: "canvas",
          error_name: "ZodError",
          component: "SequenceDiagram",
        },
      }),
    ).toEqual({
      event: "review_client_error",
      properties: {
        error_source: "document",
        error_process: "canvas",
        error_name: "ZodError",
        component: "SequenceDiagram",
      },
    });
  });

  it("drops raw error text under any property name", () => {
    const sanitized = sanitizeUiTelemetryEvent({
      name: "client_error",
      properties: {
        error_source: "renderer_unexpected",
        error_message: "Cannot read /Users/alice/secret-repo/plan.md",
        error_stack: "at boom (/Users/alice/secret-repo/plan.ts:1:1)",
        message: "Cannot read /Users/alice/secret-repo/plan.md",
      },
    });
    expect(sanitized).toEqual({
      event: "review_client_error",
      properties: { error_source: "renderer_unexpected" },
    });
    expect(JSON.stringify(sanitized)).not.toContain("alice");
  });

  it("accepts a message only when the cleaner finished the job", () => {
    const message = (value: string) =>
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: { error_source: "window", message: value },
      })?.properties.message;

    expect(message("Cannot read properties of undefined (reading 'uri')")).toBe(
      "Cannot read properties of undefined (reading 'uri')",
    );
    expect(message("failed to load <REDACTED: user-file-path>")).toBe(
      "failed to load <REDACTED: user-file-path>",
    );

    // A surviving path shape means the cleaner missed one. Fail closed.
    expect(
      message("Cannot read /Users/alice/secret-repo/plan.md"),
    ).toBeUndefined();
    expect(
      message("C:\\Users\\alice\\secret\\plan.md is missing"),
    ).toBeUndefined();
    // The secret and address shapes are re-checked here, not merely upstream.
    expect(message("see https://github.example/alice/secret")).toBeUndefined();
    expect(message("no account for alice@example.com")).toBeUndefined();
    expect(message("x".repeat(301))).toBeUndefined();
    expect(message("")).toBeUndefined();
  });

  it("keeps only stack frames that resolve inside the shipped bundle", () => {
    expect(
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: {
          error_source: "main_unexpected",
          frames: [
            "vs/review/browser/workbench.js:456:12",
            "Users/alice/secret-repo/plan.ts:1:1",
            "../../../etc/passwd:1:1",
            "assets/canvas-a1b2c3.js:1:284712",
          ].join("|"),
        },
      })?.properties.frames,
    ).toBe(
      "vs/review/browser/workbench.js:456:12|assets/canvas-a1b2c3.js:1:284712",
    );
  });

  it("drops a frame list with nothing reportable in it", () => {
    expect(
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: {
          error_source: "window",
          frames: "/Users/alice/secret-repo/plan.ts:1:1",
        },
      }),
    ).toEqual({
      event: "review_client_error",
      properties: { error_source: "window" },
    });
  });

  it("drops a `..` segment that traverses out of a bundle root", () => {
    // The continuation charset admits `.` and `/` separately, so a `..`
    // segment after a bundle root is the smuggle vector: it passes the charset
    // but escapes the bundle into user content.
    expect(
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: {
          error_source: "window",
          frames: [
            "vs/review/browser/workbench.js:456:12",
            "vs/review/../../leak.js:1:1",
            "vs/review/../../Users/alice/secret/leak.js:1:1",
            "assets/../../etc/passwd:1:1",
            "vs/review/foo/..:1:1",
            "assets/canvas-a1b2c3.js:1:284712",
          ].join("|"),
        },
      })?.properties.frames,
    ).toBe(
      "vs/review/browser/workbench.js:456:12|assets/canvas-a1b2c3.js:1:284712",
    );
  });

  it("keeps a frame whose `..` is inside a filename, not a path segment", () => {
    // A `..` run bounded by other characters is part of a file or directory
    // name, not a parent-directory reference, so it must not be over-rejected.
    expect(
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: {
          error_source: "window",
          frames: "vs/review/foo..bar.js:1:1|vs/review/v1.0.2/fix.js:1:1",
        },
      })?.properties.frames,
    ).toBe("vs/review/foo..bar.js:1:1|vs/review/v1.0.2/fix.js:1:1");
  });

  it("requires a message hash to be a truncated hex digest", () => {
    const hashed = (message_hash: string) =>
      sanitizeUiTelemetryEvent({
        name: "client_error",
        properties: { error_source: "window", message_hash },
      })?.properties.message_hash;
    expect(hashed("0123456789abcdef")).toBe("0123456789abcdef");
    expect(hashed("0123456789ABCDEF")).toBeUndefined();
    expect(hashed("not-a-digest")).toBeUndefined();
    expect(hashed("Cannot read plan")).toBeUndefined();
  });

  it("allows submitted decisions and a private app session id", () => {
    expect(
      sanitizeUiTelemetryEvent({
        name: "review_submitted",
        properties: {
          decision: "approve",
          comment_count: 2,
          app_session_id: "session-1234567890",
          review_text: "private",
        },
      }),
    ).toEqual({
      event: "review_review_submitted",
      properties: {
        decision: "approve",
        comment_count: 2,
        app_session_id: "session-1234567890",
      },
    });
  });

  it("drops out-of-enum language values", () => {
    const output = sanitizeUiTelemetryEvent({
      name: "lsp_used",
      properties: {
        feature: "hover",
        via: "mouse",
        language: "brainfuck",
        editor_kind: "files_tab",
      },
    });
    expect(output?.event).toBe("review_lsp_used");
    expect(output?.properties).toEqual({
      feature: "hover",
      via: "mouse",
      editor_kind: "files_tab",
    });
  });

  it("drops unknown extension ids", () => {
    const output = sanitizeUiTelemetryEvent({
      name: "extension_installed",
      properties: { extension_id: "evil.extension", trigger: "user" },
    });
    expect(output?.properties).toEqual({ trigger: "user" });
  });

  it("rejects unknown events", () => {
    expect(sanitizeUiTelemetryEvent({ name: "made_up" })).toBeNull();
  });

  it("allows the three update lifecycle events", () => {
    const update_attempt_id = "12345678-1234-1234-1234-123456789abc";
    expect(
      sanitizeUiTelemetryEvent({
        name: "update_started",
        properties: { update_attempt_id, target_version: "0.0.27" },
      }),
    ).toEqual({
      event: "review_update_started",
      properties: { update_attempt_id, target_version: "0.0.27" },
    });
    expect(
      sanitizeUiTelemetryEvent({
        name: "update_completed",
        properties: {
          update_attempt_id,
          target_version: "0.0.27-beta.1",
          duration_ms: 1234,
        },
      }),
    ).toEqual({
      event: "review_update_completed",
      properties: {
        update_attempt_id,
        target_version: "0.0.27-beta.1",
        duration_ms: 1234,
      },
    });
    expect(
      sanitizeUiTelemetryEvent({
        name: "update_failed",
        properties: {
          phase: "install",
          message_source: "shipit",
          update_attempt_id,
          target_version: "0.0.27",
          duration_ms: 2345,
          error_name: "UpdateInstallError",
          message: "Failed to copy <REDACTED: user-file-path>",
          message_hash: "0123456789abcdef",
        },
      }),
    ).toEqual({
      event: "review_update_failed",
      properties: {
        phase: "install",
        message_source: "shipit",
        update_attempt_id,
        target_version: "0.0.27",
        duration_ms: 2345,
        error_name: "UpdateInstallError",
        message: "Failed to copy <REDACTED: user-file-path>",
        message_hash: "0123456789abcdef",
      },
    });
  });

  it("rejects invalid update dimensions and raw update errors", () => {
    expect(
      sanitizeUiTelemetryEvent({
        name: "update_failed",
        properties: {
          phase: "restart",
          message_source: "raw_log",
          target_version: "private version",
          message: "Failed at /Users/alice/private/Review.app",
        },
      }),
    ).toEqual({ event: "review_update_failed", properties: {} });
  });

  it("drops unknown property keys", () => {
    const output = sanitizeUiTelemetryEvent({
      name: "lsp_used",
      properties: {
        feature: "hover",
        via: "mouse",
        language: "rust",
        editor_kind: "diff",
        file_path: "/etc/passwd",
      },
    });
    expect(output?.properties).not.toHaveProperty("file_path");
  });
});
