import path from "node:path";

import { buildReviewDocument } from "./document/build";
import { formatReviewDocumentDiagnostics } from "./document/diagnostics";

export async function runReviewInternalTest(reviewDir: string): Promise<void> {
  const result = await buildReviewDocument({
    reviewPath: path.join(reviewDir, "review.mdx"),
    ranges: "skip",
    typecheck: "review",
  });

  if (!result.document)
    throw new Error(
      formatReviewDocumentDiagnostics(result.diagnostics) ||
        result.errors.join("\n"),
    );
}
