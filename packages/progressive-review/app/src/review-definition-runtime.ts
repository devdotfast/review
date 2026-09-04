import type { CodePeekProps, CodePeekResolution } from "../../src/authoring";
import type { ReviewSession } from "./host/review-session";

const REVIEW_CODE_PEEK_RESOLUTION_CONCURRENCY = 8;
let activeCodePeekResolutions = 0;
const pendingCodePeekResolutionSlots: Array<() => void> = [];

export const reviewDefinitionDiagnostics = {
  authoredCodePeekRequestCount: 0,
  authoredCodePeekDiffRequestCount: 0,
};

export async function resolveCodePeekRequest(
  routePath: string,
  props: CodePeekProps,
  session: ReviewSession,
): Promise<CodePeekResolution> {
  recordAuthoredCodePeekRequest(false);
  const response = await session.fetch(
    "/code-peek/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: codePeekRoot(props),
        graph: props.graph ?? "head",
        includeDiff: false,
        includeDiffSummary: true,
      }),
    },
    { routePath },
  );
  // SAFETY: the authenticated review route returns CodePeekResolution on
  // success and a human-readable error response otherwise.
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
