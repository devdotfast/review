import type { CallStackChangedLines, CallStackSide } from "../call-stack-diff";
import type {
  ReviewPublishEvaluationResult,
  ReviewPublishEvidenceTargets,
} from "../review-publication-audit";
import type { ReviewDocumentDiagnostic } from "./diagnostics";
import type { DocumentSyntax } from "./syntax";

export interface DocumentWorkerInput {
  reviewPath: string;
  routePath: string;
  syntax: DocumentSyntax;
  runtimeBindings: string[];
  typeOnlyExports: Record<string, string[]>;
  ranges: "validate" | "skip";
  hasEvidence: boolean;
  hasChangedLines: boolean;
}

export interface DocumentWorkerResult {
  result: ReviewPublishEvaluationResult;
  diagnostics: ReviewDocumentDiagnostic[];
}

export interface DocumentWorkerApi {
  build(): Promise<DocumentWorkerResult>;
}

export interface DocumentWorkerCallbacks {
  prepareEvidence(): Promise<ReviewPublishEvidenceTargets>;
  resolveChangedLines(
    file: string,
    side: CallStackSide,
  ): Promise<CallStackChangedLines | null>;
}
