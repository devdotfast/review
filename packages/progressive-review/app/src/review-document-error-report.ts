import type { ReviewSession } from "./host/review-session";

// Wire contract for shipping a review-document render failure from the browser
// to the CLI. Under the standalone review server there is no HMR channel:
// `import.meta.hot` is undefined in the esbuild-built document bundle, so
// reportReviewDocumentRenderError is a no-op there. The contract is kept for
// the error boundary call site until browser error forwarding is rewired
// through the review server's event stream.

export const REVIEW_DOCUMENT_ERROR_EVENT = "review:document-error";

export interface ReviewDocumentErrorReport {
  name: string;
  message: string;
  stack?: string;
}

export function reviewDocumentErrorReport(
  error: unknown,
): ReviewDocumentErrorReport {
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
  // `import.meta.hot` exists only in the Vite dev client, which is the only
  // place a componentDidCatch runs for this app; it is undefined under SSR.
  import.meta.hot?.send(REVIEW_DOCUMENT_ERROR_EVENT, report);
}
