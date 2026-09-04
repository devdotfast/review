import type { ReviewSession } from "./host/review-session";

function reviewDocumentErrorReport(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  const value = error as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
  } | null;
  return {
    name: typeof value?.name === "string" ? value.name : "Error",
    message: typeof value?.message === "string" ? value.message : String(error),
    ...(typeof value?.stack === "string" ? { stack: value.stack } : {}),
  };
}

export function reportReviewDocumentRenderError(
  session: ReviewSession,
  error: unknown,
): void {
  const report = reviewDocumentErrorReport(error);
  session.reportDiagnostic({
    level: "error",
    source: "render",
    message: `${report.name}: ${report.message}`,
    ...(report.stack ? { stack: report.stack } : {}),
  });
}
