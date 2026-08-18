export type ReviewView = "review" | "commits" | "map" | "diff" | "trace";

export function normalizeReviewView(
  view: ReviewView,
  softwareMapEnabled: boolean,
  hasChangeRange = true,
): ReviewView {
  if (view === "map" && !softwareMapEnabled) return "review";
  if (
    !hasChangeRange &&
    (view === "commits" || view === "diff" || view === "trace")
  ) {
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
