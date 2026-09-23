import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  WHITEBOARD_DOCUMENT_ERROR_EVENT,
  whiteboardDocumentErrorReport,
} from "./whiteboard-document-error-report";

describe("whiteboardDocumentErrorReport", () => {
  it("keeps a stable channel name for the CLI listener", () => {
    expect(WHITEBOARD_DOCUMENT_ERROR_EVENT).toBe("review:document-error");
  });

  it("captures name, message, and stack from an Error", () => {
    const error = new TypeError("sequence actor exploded");
    const report = whiteboardDocumentErrorReport(error);
    expect(report.name).toBe("TypeError");
    expect(report.message).toBe("sequence actor exploded");
    expect(report.stack).toContain("sequence actor exploded");
  });

  it("preserves the authoring ZodError name and issue text", () => {
    const zodError = new z.ZodError([
      {
        code: "custom",
        path: ["messages", 1, "label"],
        message: "Sequence message label is required",
        input: undefined,
      },
    ]);

    const report = whiteboardDocumentErrorReport(zodError);
    expect(report.name).toBe("ZodError");
    expect(report.message).toContain("Sequence message label is required");
  });

  it("falls back to a stringified value for a non-Error throw", () => {
    const report = whiteboardDocumentErrorReport("boom");
    expect(report).toEqual({ name: "Error", message: "boom" });
  });
});
