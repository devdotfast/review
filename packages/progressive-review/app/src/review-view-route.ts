export type ReviewView = "review" | "commits" | "map" | "diff";

export function normalizeReviewView(
  view: ReviewView,
  softwareMapEnabled: boolean,
  hasChangeRange = true,
): ReviewView {
  if (view === "map" && !softwareMapEnabled) return "review";
  if (!hasChangeRange && (view === "commits" || view === "diff")) {
    return "review";
  }
  return view;
}

export function reviewViewLabel(view: ReviewView): string {
  if (view === "map") return "Map";
  if (view === "diff") return "Diff";
  if (view === "commits") return "Commits";
  return "Review";
}

export function shouldCloseSidePeekForReviewView(view: ReviewView): boolean {
  return view !== "review";
}
