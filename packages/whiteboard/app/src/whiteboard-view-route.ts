import type { WhiteboardView } from "@dev.fast/whiteboard-protocol";

export type { WhiteboardView } from "@dev.fast/whiteboard-protocol";

export function normalizeWhiteboardView(
  view: WhiteboardView,
  softwareMapEnabled: boolean,
  hasChangeRange = true,
  hasTraceSessions = true,
): WhiteboardView {
  if (view === "map" && !softwareMapEnabled) return "review";

  if (view === "trace" && !hasTraceSessions) return "review";

  if (!hasChangeRange && (view === "commits" || view === "diff")) {
    return "review";
  }

  return view;
}

export function whiteboardViewLabel(view: WhiteboardView): string {
  if (view === "map") return "Map";

  if (view === "diff") return "Diff";

  if (view === "commits") return "Commits";

  if (view === "trace") return "Trace";

  return "Whiteboard";
}

export function shouldCloseSidePeekForWhiteboardView(
  view: WhiteboardView,
): boolean {
  return view !== "review";
}
