import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  REVIEW_DOCUMENT_ERROR_EVENT,
  reviewDocumentErrorReport,
} from "./review-document-error-report";

describe("reviewDocumentErrorReport", () => {
  it("keeps a stable channel name for the CLI listener", () => {
    expect(REVIEW_DOCUMENT_ERROR_EVENT).toBe("review:document-error");
  });

  it("captures name, message, and stack from an Error", () => {
    const error = new TypeError("sequence actor exploded");
    const report = reviewDocumentErrorReport(error);
    expect(report.name).toBe("TypeError");
    expect(report.message).toBe("sequence actor exploded");
    expect(report.stack).toContain("sequence actor exploded");
  });

  it("preserves the authoring ZodError name and issue text", () => {
    const zodError = new z.ZodError([
      {
        code: "custom",
        path: ["messages", 1, "label"],
        message: "Label must be unique among parallel A→B messages",
        input: undefined,
      },
    ]);
    const report = reviewDocumentErrorReport(zodError);
    expect(report.name).toBe("ZodError");
    expect(report.message).toContain(
      "Label must be unique among parallel A→B messages",
    );
  });

  it("falls back to a stringified value for a non-Error throw", () => {
    const report = reviewDocumentErrorReport("boom");
    expect(report).toEqual({ name: "Error", message: "boom" });
  });
});
