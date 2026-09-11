import { readFile } from "node:fs/promises";

import type {
  ReviewPublishEvaluationInput,
  ReviewPublishEvaluationResult,
} from "../review-publication-audit";
import { checkReviewDocument } from "./check";
import type { ReviewDocumentDiagnostic } from "./diagnostics";
import { parseReviewDocument } from "./mdx-parser";
import {
  DocumentParseError,
  type DocumentParser,
  type DocumentSyntax,
} from "./syntax";
import { runDocumentWorker } from "./worker-client";

export interface DocumentBuildInput extends ReviewPublishEvaluationInput {
  reviewPath: string;
  routePath?: string;
  signal?: AbortSignal;
  typecheck?: "document" | "review";
}

export interface DocumentBuildResult extends ReviewPublishEvaluationResult {
  diagnostics: ReviewDocumentDiagnostic[];
}

export async function buildReviewDocument(
  input: DocumentBuildInput,
  parser: DocumentParser = parseReviewDocument,
): Promise<DocumentBuildResult> {
  input.signal?.throwIfAborted();
  const source = await readFile(input.reviewPath, "utf8");
  let syntax: DocumentSyntax;

  try {
    syntax = await parser(source);
  } catch (error) {
    if (!(error instanceof DocumentParseError)) throw error;

    return {
      document: null,
      errors: [],
      warnings: [],
      peekCount: 0,
      rangePeeks: [],
      diagnostics: [
        {
          source: "mdx",
          severity: "error",
          code: "MDX_PARSE_ERROR",
          message: error.message,
          filePath: input.reviewPath,
          line: error.line,
          column: error.column,
        },
      ],
    };
  }

  const { diagnostics, runtimeBindings, typeOnlyExports } = checkReviewDocument(
    {
      filePath: input.reviewPath,
      source,
      syntax,
      typecheck: input.typecheck,
    },
  );

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return {
      document: null,
      diagnostics,
      errors: [],
      warnings: [],
      peekCount: 0,
      rangePeeks: [],
    };
  input.signal?.throwIfAborted();

  const result = await runDocumentWorker(
    {
      reviewPath: input.reviewPath,
      routePath: input.routePath ?? "/",
      syntax,
      runtimeBindings,
      typeOnlyExports,
      ranges: input.ranges ?? "validate",
      hasEvidence: Boolean(input.prepareEvidence),
      hasChangedLines: Boolean(input.resolveChangedLines),
    },
    input,
    input.signal,
  );

  return {
    ...result.result,
    diagnostics: [...diagnostics, ...result.diagnostics],
  };
}
