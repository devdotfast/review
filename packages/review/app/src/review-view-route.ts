import type { ReviewView } from "@dev.fast/review-protocol";

export type { ReviewView } from "@dev.fast/review-protocol";

export function normalizeReviewView(
  view: ReviewView,
  softwareMapEnabled: boolean,
  hasChangeRange = true,
  hasTraceSessions = true,
): ReviewView {
  if (view === "map" && !softwareMapEnabled) return "review";

  if (view === "trace" && !hasTraceSessions) return "review";

  if (!hasChangeRange && (view === "commits" || view === "diff")) {
    return "review";
  }

  return view;
}

export function reviewViewLabel(view: ReviewView): string {
  if (view === "map") return "Map";

  if (view === "diff") return "Diff";

  if (view === "commits") return "Commits";

  if (view === "trace") return "Trace";

  return "Review";
}

export function shouldCloseSidePeekForReviewView(view: ReviewView): boolean {
  return view !== "review";
}
