import {
  type WhiteboardCanvasDiagnostic,
  isJsonObject,
  jsonString,
} from "@dev.fast/whiteboard-protocol";

import type { WhiteboardSession } from "./host/whiteboard-session";

// Wire contract for shipping a whiteboard-document render failure from the browser
// to the CLI. Under the standalone review server there is no HMR channel:
// `import.meta.hot` is undefined in the esbuild-built document bundle, so
// reportWhiteboardDocumentRenderError is a no-op there. The contract is kept for
// the error boundary call site until browser error forwarding is rewired
// through the review server's event stream.

export const WHITEBOARD_DOCUMENT_ERROR_EVENT = "review:document-error";

export interface WhiteboardDocumentErrorReport {
  name: string;
  message: string;
  stack?: string;
}

export function whiteboardDocumentErrorReport(
  cause: unknown,
): WhiteboardDocumentErrorReport {
  if (cause instanceof Error) {
    const report: WhiteboardDocumentErrorReport = {
      name: cause.name,
      message: cause.message,
    };

    if (cause.stack) report.stack = cause.stack;

    return report;
  }

  const fields = isJsonObject(cause) ? cause : undefined;
  const stack = jsonString(fields?.stack);

  const report: WhiteboardDocumentErrorReport = {
    name: jsonString(fields?.name) ?? "Error",
    message: jsonString(fields?.message) ?? String(cause),
  };

  if (stack !== undefined) report.stack = stack;

  return report;
}

export function reportWhiteboardDocumentRenderError(
  session: WhiteboardSession,
  cause: unknown,
): void {
  const report = whiteboardDocumentErrorReport(cause);

  const diagnostic: WhiteboardCanvasDiagnostic = {
    level: "error",
    source: "render",
    message: `${report.name}: ${report.message}`,
  };

  if (report.stack) diagnostic.stack = report.stack;
  session.reportDiagnostic(diagnostic);
  // `import.meta.hot` exists only in the Vite dev client, which is the only
  // place a componentDidCatch runs for this app; it is undefined under SSR.
  import.meta.hot?.send(WHITEBOARD_DOCUMENT_ERROR_EVENT, report);
}
