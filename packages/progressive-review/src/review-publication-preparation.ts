import path from "node:path";

import { patchChangedLines } from "./call-stack-diff";
import type { ReviewDocumentDiagnostic } from "./compiler/review-document-compiler";
import { writeReviewDocumentBundle } from "./review-bundle";
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
import {
  compileReviewDocumentBundle,
  embedCodePeeks,
} from "./server/doc-bundler";
import {
  type ReviewSoftwareMapBundle,
  bundleReviewSoftwareMap,
} from "./software-map-bundle";
import { loadPublishSoftwareMaps } from "./software-map-health";
import { span } from "./startup-trace";

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
  const compiled = await span("publish: compile document bundle", () =>
    compileReviewDocumentBundle({
      reviewPath: path.join(input.review.dir, "review.mdx"),
      reviewDocumentsDir: path.join(input.review.dir, ".review-documents"),
      reviewRootPath: input.review.dir,
      routePath: "/",
    }),
  );
  const bundle = compiled.bundle;
  if (!bundle) {
    throw new ReviewPublicationValidationError(
      [],
      compiled.diagnostics,
      warnings,
    );
  }
  let sourceTargetPromise: Promise<ReviewSourceTarget> | null = null;
  const sourceTarget = () =>
    (sourceTargetPromise ??= span("publish: resolve source target", () =>
      resolveReviewSourceTarget({
        reviewRootPath: input.review.dir,
        warning: (message) => warnings.push(message),
      }),
    ));
  let diffFilesPromise: Promise<ReviewDiffFilesResult> | null = null;
  const diffFiles = async () => {
    const source = await sourceTarget();
    return (diffFilesPromise ??= span("publish: resolve diff files", () =>
      resolveReviewDiffFiles({
        rootPath: source.diffRootPath,
        baseRef: source.baseRef,
        headRef: source.headRef,
        includePatch: true,
      }),
    ));
  };
  const evaluation = await span("publish: evaluate document", () =>
    evaluateReviewDocumentBundleForPublish({
      bundleCode: bundle.code,
      reviewDir: input.review.dir,
      prepareEvidence: async () => {
        const source = await sourceTarget();
        return {
          head: { sourceRootPath: source.sourceRootPath },
          base: source.preparedBase
            ? { sourceRootPath: source.preparedBase.sourceRootPath }
            : undefined,
          diff: {
            baseRef: source.baseRef,
            headRef: source.headRef,
            files: async () => (await diffFiles()).files,
          },
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
    }),
  );
  if (evaluation.errors.length > 0) {
    throw new ReviewPublicationValidationError(evaluation.errors, undefined, [
      ...new Set([...warnings, ...evaluation.warnings]),
    ]);
  }
  // The desktop mounts the bundle without a request per peek: every
  // resolution evaluate just produced ships inside the bundle.
  const published = embedCodePeeks(bundle, evaluation.codePeeks);
  await span("publish: write document bundle", () =>
    writeReviewDocumentBundle(input.review.dir, published),
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
  const maps = await span("map publish: load software maps", () =>
    loadPublishSoftwareMaps({
      repoRootPath: input.review.review.worktreePath,
      baseCommit: input.baseCommit ?? input.review.review.baseCommit,
      headCommit: sourceCommit,
    }),
  );
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
