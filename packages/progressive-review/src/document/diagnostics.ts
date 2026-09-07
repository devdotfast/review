import { readFileSync } from "node:fs";

export interface ReviewDocumentDiagnostic {
  source: "mdx" | "typescript" | "review" | "evidence";
  severity: "error" | "warning";
  code: string;
  message: string;
  filePath: string;
  line?: number;
  column?: number;
}

export function formatReviewDocumentDiagnostics(
  diagnostics: readonly ReviewDocumentDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const location = [diagnostic.filePath, diagnostic.line, diagnostic.column]
        .filter((value) => value !== undefined)
        .join(":");
      const summary = `${location} ${diagnostic.code}: ${diagnostic.message}`;
      const codeFrame = formatDiagnosticCodeFrame(diagnostic);
      return codeFrame ? `${summary}\n${codeFrame}` : summary;
    })
    .join("\n");
}

function formatDiagnosticCodeFrame(
  diagnostic: ReviewDocumentDiagnostic,
): string | null {
  if (
    !Number.isInteger(diagnostic.line) ||
    !Number.isInteger(diagnostic.column) ||
    diagnostic.line === undefined ||
    diagnostic.column === undefined ||
    diagnostic.line < 1 ||
    diagnostic.column < 1
  ) {
    return null;
  }
  try {
    const sourceLine = readFileSync(diagnostic.filePath, "utf8").split(
      /\r\n|\n|\r/,
    )[diagnostic.line - 1];
    if (sourceLine === undefined || diagnostic.column > sourceLine.length + 1) {
      return null;
    }
    const safeLine = sanitizeDiagnosticSource(sourceLine);
    let caretOffset = sanitizeDiagnosticSource(
      sourceLine.slice(0, diagnostic.column - 1),
    ).length;
    const maxLength = 160;
    let windowStart = Math.max(0, caretOffset - 80);
    let windowEnd = Math.min(safeLine.length, windowStart + maxLength);
    if (windowEnd === safeLine.length) {
      windowStart = Math.max(0, windowEnd - maxLength);
    }
    const leadingEllipsis = windowStart > 0 ? "…" : "";
    const trailingEllipsis = windowEnd < safeLine.length ? "…" : "";
    const visibleLine = `${leadingEllipsis}${safeLine.slice(windowStart, windowEnd)}${trailingEllipsis}`;
    caretOffset =
      leadingEllipsis.length + Math.max(0, caretOffset - windowStart);
    const gutterWidth = String(diagnostic.line).length;
    return [
      `${diagnostic.line} | ${visibleLine}`,
      `${" ".repeat(gutterWidth)} | ${" ".repeat(caretOffset)}^`,
    ].join("\n");
  } catch {
    return null;
  }
}

function sanitizeDiagnosticSource(source: string): string {
  return source
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}
