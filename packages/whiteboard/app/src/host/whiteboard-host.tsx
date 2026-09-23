import type {
  WhiteboardCanvasBridge,
  WhiteboardDiffFileWire,
  WhiteboardDiffSide,
  WhiteboardRangeWire,
  WhiteboardSourcePins,
  WhiteboardSurfaceEvent,
  WhiteboardVerbRequest,
} from "@dev.fast/whiteboard-protocol";

export interface WhiteboardSurface {
  openFileDiff(file: WhiteboardDiffFileWire): void;
  /** `pins` opens the file at a reference's own pins instead of the review's. */
  revealAnchor(
    path: string,
    range: WhiteboardRangeWire,
    side?: WhiteboardDiffSide,
    pins?: WhiteboardSourcePins,
  ): void;
  post(request: WhiteboardVerbRequest): Promise<void>;
  subscribe(listener: (event: WhiteboardSurfaceEvent) => void): () => void;
}

export function createWhiteboardSurface(
  bridge: WhiteboardCanvasBridge,
): WhiteboardSurface {
  return {
    openFileDiff(file) {
      void bridge.post({
        name: "openDiff",
        args: { path: file.path, previousPath: file.previousPath },
      });
    },
    revealAnchor(path, range, side, pins) {
      void bridge.post({
        name: "reveal",
        args: {
          path,
          startLine: range.fromLine,
          endLine: range.toLine,
          side,
          pins,
          highlight: true,
          preserveFocus: false,
        },
      });
    },
    async post(request) {
      const response = await bridge.post(request);

      if (!response.ok) throw new Error(response.error);
    },
    subscribe(listener) {
      const subscription = bridge.subscribe(listener);

      return () => subscription.dispose();
    },
  };
}
