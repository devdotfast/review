import path from "node:path";

import { patchChangedLines } from "./call-stack-diff";
import type { ReviewDocumentDiagnostic } from "./compiler/review-document-compiler";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  type ReviewDiffFilesResult,
  resolveReviewDiffFiles,
} from "./review-diff-files";
import type { StoredReview } from "./review-home";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import {
  type ReviewSourceTarget,
  resolveReviewSourceTarget,
} from "./review-worktree-target";
import { compileReviewDocumentBundle } from "./server/doc-bundler";
import {
  type ReviewSoftwareMapBundle,
  bundleReviewSoftwareMap,
} from "./software-map-bundle";
import { loadPublishSoftwareMaps } from "./software-map-health";

/** A validation failure with the structure the publish reporters need:
    compile diagnostics keep file/line/column, evaluation and map failures
    are plain messages. The joined `message` serves non-reporter callers. */
export class ReviewPublicationValidationError extends Error {
  override readonly name = "ReviewPublicationValidationError";

  constructor(
    readonly errors: string[],
    readonly diagnostics: ReviewDocumentDiagnostic[] | undefined,
    readonly warnings: string[],
  ) {
    super(
      (diagnostics
        ?.map((diagnostic) =>
          [
            diagnostic.filePath,
            diagnostic.line,
            diagnostic.column,
            diagnostic.message,
          ]
            .filter((part) => part !== undefined)
            .join(":"),
        )
        .join("\n") ??
        errors.join("\n")) ||
        "Review validation failed.",
    );
  }
}

export async function prepareReviewDocumentBundle(input: {
  review: StoredReview;
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const compiled = await compileReviewDocumentBundle({
    reviewPath: path.join(input.review.dir, "review.mdx"),
    reviewDocumentsDir: path.join(input.review.dir, ".review-documents"),
    reviewRootPath: input.review.dir,
    routePath: "/",
  });
  if (!compiled.bundle) {
    throw new ReviewPublicationValidationError(
      [],
      compiled.diagnostics,
      warnings,
    );
  }
  let sourceTargetPromise: Promise<ReviewSourceTarget> | null = null;
  const sourceTarget = () =>
    (sourceTargetPromise ??= resolveReviewSourceTarget({
      reviewRootPath: input.review.dir,
      warning: (message) => warnings.push(message),
    }));
  let diffFilesPromise: Promise<ReviewDiffFilesResult> | null = null;
  const diffFiles = async () => {
    const source = await sourceTarget();
    return (diffFilesPromise ??= resolveReviewDiffFiles({
      rootPath: source.diffRootPath,
      baseRef: source.baseRef,
      headRef: source.headRef,
      includePatch: true,
    }));
  };
  const evaluation = await evaluateReviewDocumentBundleForPublish({
    bundleCode: compiled.bundle.code,
    reviewDir: input.review.dir,
    prepareEvidence: async () => {
      const source = await sourceTarget();
      return {
        head: { sourceRootPath: source.sourceRootPath },
        base: source.preparedBase
          ? { sourceRootPath: source.preparedBase.sourceRootPath }
          : undefined,
      };
    },
    // A "-" frame must anchor lines the change deletes and a "+" frame
    // lines it adds; the lines come from the same pinned-commit diff the
    // rest of the review presents.
    resolveChangedLines: async (file, side) => {
      const { files } = await diffFiles();
      const match = files.find((candidate) =>
        side === "base"
          ? (candidate.previousPath ?? candidate.path) === file
          : candidate.path === file,
      );
      return match?.patch ? patchChangedLines(match.patch) : null;
    },
  });
  if (!evaluation.document) {
    throw new ReviewPublicationValidationError(
      evaluation.errors.length > 0
        ? evaluation.errors
        : ["Review document did not materialize."],
      undefined,
      [...new Set([...warnings, ...evaluation.warnings])],
    );
  }
  await writeReviewDocumentBundle(
    input.review.dir,
    bundleReviewDocument(evaluation.document),
  );
  return { warnings: [...new Set([...warnings, ...evaluation.warnings])] };
}

/** Validates and bundles the software map. The caller decides when to
    write the bundle into the review dir — a no-change publish must not
    mutate the candidate before its comparison runs. */
export async function prepareReviewSoftwareMapBundle(input: {
  review: StoredReview;
  baseCommit?: string;
  headCommit?: string;
}): Promise<ReviewSoftwareMapBundle> {
  const sourceCommit = input.headCommit ?? input.review.review.sourceCommit;
  if (!sourceCommit) {
    throw new Error("The Review has no pinned head commit.");
  }
  const maps = await loadPublishSoftwareMaps({
    repoRootPath: input.review.review.worktreePath,
    baseCommit: input.baseCommit ?? input.review.review.baseCommit,
    headCommit: sourceCommit,
  });
  if (maps.errors.length > 0 || !maps.head || !maps.base) {
    throw new ReviewPublicationValidationError(
      maps.errors.length > 0
        ? maps.errors
        : ["Software map validation failed."],
      undefined,
      [],
    );
  }
  return bundleReviewSoftwareMap({
    head: maps.head,
    base: maps.base,
    headCommit: sourceCommit,
    baseCommit: input.baseCommit ?? input.review.review.baseCommit,
  });
}
