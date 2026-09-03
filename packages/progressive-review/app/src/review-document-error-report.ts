import {
  type ReviewCanvasDiagnostic,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

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
  cause: unknown,
): ReviewDocumentErrorReport {
  if (cause instanceof Error) {
    const report: ReviewDocumentErrorReport = {
      name: cause.name,
      message: cause.message,
    };
    if (cause.stack) report.stack = cause.stack;
    return report;
  }
  const fields = isJsonObject(cause) ? cause : undefined;
  const stack = jsonString(fields?.stack);
  const report: ReviewDocumentErrorReport = {
    name: jsonString(fields?.name) ?? "Error",
    message: jsonString(fields?.message) ?? String(cause),
  };
  if (stack !== undefined) report.stack = stack;
  return report;
}

export function reportReviewDocumentRenderError(
  session: ReviewSession,
  cause: unknown,
): void {
  const report = reviewDocumentErrorReport(cause);
  const diagnostic: ReviewCanvasDiagnostic = {
    level: "error",
    source: "render",
    message: `${report.name}: ${report.message}`,
  };
  if (report.stack) diagnostic.stack = report.stack;
  session.reportDiagnostic(diagnostic);
  // `import.meta.hot` exists only in the Vite dev client, which is the only
  // place a componentDidCatch runs for this app; it is undefined under SSR.
  import.meta.hot?.send(REVIEW_DOCUMENT_ERROR_EVENT, report);
}
