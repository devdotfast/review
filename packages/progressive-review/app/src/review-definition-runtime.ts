import {
  type CodePeekProps,
  type CodePeekResolution,
  type ReviewDefinitionSession,
  calls,
  createReviewDefinitionSession,
} from "../../src/authoring";

export { calls };
import { reviewFetch } from "./host/review-client";
import type { NormalizedSoftwareModel } from "./software-map/model";

const REVIEW_CODE_PEEK_RESOLUTION_CONCURRENCY = 8;
let activeCodePeekResolutions = 0;
const pendingCodePeekResolutionSlots: Array<() => void> = [];

export interface ReviewRequestContext {
  origin?: string;
  token?: string;
}

// Published bundles are origin-agnostic: the canvas sets this context after it
// imports the runtime and before it imports the document module, so the same
// bundle can be served from any session origin.
let reviewRequestContext: ReviewRequestContext | null = null;

export function setReviewRequestContext(context: ReviewRequestContext): void {
  reviewRequestContext = context;
}

export const reviewDefinitionDiagnostics = {
  authoredCodePeekRequestCount: 0,
  authoredCodePeekDiffRequestCount: 0,
};

export function createBrowserReviewDefinitionSession(input: {
  routePath: string;
  softwareMap: NormalizedSoftwareModel | null;
  baseSoftwareMap: NormalizedSoftwareModel | null;
  mapDependentComponents?: readonly string[];
  resolveCodePeeks?: boolean;
  requestOrigin?: string;
  requestToken?: string;
}): ReviewDefinitionSession {
  // Capture the canvas-provided context at session creation, which happens
  // while the document module imports. Baked-in values still win so bundles
  // produced before the origin-agnostic change keep working.
  const requestOrigin = input.requestOrigin ?? reviewRequestContext?.origin;
  const requestToken = input.requestToken ?? reviewRequestContext?.token;
  return createReviewDefinitionSession({
    softwareMap: input.softwareMap,
    baseSoftwareMap: input.baseSoftwareMap,
    mapDependentComponents: input.mapDependentComponents,
    resolveCodePeek:
      input.resolveCodePeeks === false
        ? undefined
        : (props) =>
            resolveCodePeek(
              input.routePath,
              props,
              requestOrigin,
              requestToken,
            ),
  });
}

async function resolveCodePeek(
  routePath: string,
  props: CodePeekProps,
  requestOrigin: string | undefined,
  requestToken: string | undefined,
): Promise<CodePeekResolution> {
  return runWithCodePeekResolutionSlot(() =>
    resolveCodePeekRequest(routePath, props, requestOrigin, requestToken),
  );
}

async function resolveCodePeekRequest(
  routePath: string,
  props: CodePeekProps,
  requestOrigin: string | undefined,
  requestToken: string | undefined,
): Promise<CodePeekResolution> {
  const includeDiff = false;
  const includeDiffSummary = true;
  recordAuthoredCodePeekRequest(includeDiff);
  const response = await reviewFetch(
    {
      sessionUrl: requestOrigin,
      routePath,
      token: requestToken,
    },
    "/code-peek/resolve",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        root: codePeekRoot(props),
        graph: props.graph ?? "head",
        includeDiff,
        includeDiffSummary,
      }),
    },
  );
  const json = (await response.json()) as
    | ({ ok: true } & CodePeekResolution)
    | { ok: false; error?: string };
  if (!response.ok || !json.ok) {
    throw new Error(
      json.ok
        ? "CodePeek resolve failed"
        : (json.error ?? "CodePeek resolve failed"),
    );
  }
  return { snapshot: json.snapshot, diff: json.diff };
}

function recordAuthoredCodePeekRequest(includeDiff: boolean): void {
  reviewDefinitionDiagnostics.authoredCodePeekRequestCount += 1;
  if (includeDiff) {
    reviewDefinitionDiagnostics.authoredCodePeekDiffRequestCount += 1;
  }
}

export async function runWithCodePeekResolutionSlot<T>(
  resolve: () => Promise<T>,
): Promise<T> {
  if (activeCodePeekResolutions >= REVIEW_CODE_PEEK_RESOLUTION_CONCURRENCY) {
    await new Promise<void>((grant) => {
      pendingCodePeekResolutionSlots.push(grant);
    });
  }
  activeCodePeekResolutions += 1;
  try {
    return await resolve();
  } finally {
    activeCodePeekResolutions -= 1;
    pendingCodePeekResolutionSlots.shift()?.();
  }
}

function codePeekRoot(props: CodePeekProps) {
  return {
    kind: "range" as const,
    file: props.file,
    fromLine: props.fromLine,
    toLine: props.toLine,
  };
}
