import type {
  ReviewCanvasBridge,
  ReviewDiffFileWire,
  ReviewDiffSide,
  ReviewRangeWire,
  ReviewSurfaceEvent,
  ReviewVerbRequest,
} from "@dev.fast/review-protocol";

export interface ReviewSurface {
  showThreads(): void;
  openFileDiff(file: ReviewDiffFileWire): void;
  revealAnchor(
    path: string,
    range: ReviewRangeWire,
    side?: ReviewDiffSide,
  ): void;
  post(request: ReviewVerbRequest): void;
  subscribe(listener: (event: ReviewSurfaceEvent) => void): () => void;
}

export function createReviewSurface(bridge: ReviewCanvasBridge): ReviewSurface {
  return {
    showThreads() {
      void bridge.post({ name: "showThreads", args: {} });
    },
    openFileDiff(file) {
      void bridge.post({
        name: "openDiff",
        args: { path: file.path, previousPath: file.previousPath },
      });
    },
    revealAnchor(path, range, side) {
      void bridge.post({
        name: "reveal",
        args: {
          path,
          startLine: range.fromLine,
          endLine: range.toLine,
          side,
          highlight: true,
          preserveFocus: false,
        },
      });
    },
    post(request) {
      void bridge.post(request);
    },
    subscribe(listener) {
      const subscription = bridge.subscribe(listener);
      return () => subscription.dispose();
    },
  };
}
