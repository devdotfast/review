import type {
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useReviewUiState } from "./review-ui-state";

type RightPanelResizeOptions = {
  /** Names the panel whose width is remembered across remounts. */
  stateKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  minMainWidth: number;
  separatorWidth?: number;
  label: string;
  containerRef?: RefObject<HTMLElement | null>;
};

type SeparatorProps = HTMLAttributes<HTMLDivElement> & {
  role: "separator";
  "aria-label": string;
  "aria-orientation": "vertical";
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  tabIndex: 0;
};

type BottomSheetResizeOptions = {
  /** Names the sheet whose height fraction is remembered across remounts. */
  stateKey: string;
  defaultFraction?: number;
  minFraction?: number;
  maxFraction?: number;
  label: string;
  containerRef?: RefObject<HTMLElement | null>;
};

type SheetSeparatorProps = HTMLAttributes<HTMLDivElement> & {
  role: "separator";
  "aria-label": string;
  "aria-orientation": "horizontal";
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  tabIndex: 0;
};

/**
 * Drag state for the narrow-layout bottom sheet: the panel's height as a
 * fraction of its container, remembered across remounts. The grabber only
 * renders in narrow layouts, so the hook is inert on wide screens.
 */
export function useBottomSheetResize({
  stateKey,
  defaultFraction = 0.5,
  minFraction = 0.3,
  maxFraction = 0.85,
  label,
  containerRef,
}: BottomSheetResizeOptions) {
  const [requestedFraction, setRequestedFraction] = useReviewUiState(
    stateKey,
    defaultFraction,
  );
  const [isResizing, setIsResizing] = useState(false);

  const clampFraction = useCallback(
    (fraction: number) =>
      Math.min(Math.max(fraction, minFraction), maxFraction),
    [maxFraction, minFraction],
  );
  const fraction = clampFraction(requestedFraction);

  const containerMetrics = useCallback(() => {
    const rect = containerRef?.current?.getBoundingClientRect();
    const viewportHeight =
      typeof window === "undefined"
        ? Number.POSITIVE_INFINITY
        : window.innerHeight;
    return {
      bottom: rect?.bottom ?? viewportHeight,
      height: rect?.height ?? viewportHeight,
    };
  }, [containerRef]);

  const resizeFromClientY = useCallback(
    (clientY: number) => {
      const { bottom, height } = containerMetrics();
      if (!Number.isFinite(height) || height <= 0) return;
      setRequestedFraction((bottom - clientY) / height);
    },
    [containerMetrics, setRequestedFraction],
  );

  const startResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsResizing(true);
      resizeFromClientY(event.clientY);
    },
    [resizeFromClientY],
  );

  const resize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isResizing) return;
      resizeFromClientY(event.clientY);
    },
    [isResizing, resizeFromClientY],
  );

  const stopResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizing(false);
  }, []);

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setRequestedFraction((current) => clampFraction(current) + 0.05);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setRequestedFraction((current) => clampFraction(current) - 0.05);
      }
    },
    [clampFraction, setRequestedFraction],
  );

  const separatorProps = useMemo<SheetSeparatorProps>(
    () => ({
      role: "separator",
      "aria-label": label,
      "aria-orientation": "horizontal",
      "aria-valuemin": Math.round(minFraction * 100),
      "aria-valuemax": Math.round(maxFraction * 100),
      "aria-valuenow": Math.round(fraction * 100),
      tabIndex: 0,
      onPointerDown: startResize,
      onPointerMove: resize,
      onPointerUp: stopResize,
      onPointerCancel: stopResize,
      onLostPointerCapture: () => setIsResizing(false),
      onKeyDown: resizeWithKeyboard,
    }),
    [
      fraction,
      label,
      maxFraction,
      minFraction,
      resize,
      resizeWithKeyboard,
      startResize,
      stopResize,
    ],
  );

  return {
    fraction,
    isResizing,
    separatorProps,
  };
}

export function useRightPanelResize({
  stateKey,
  defaultWidth,
  minWidth,
  maxWidth,
  minMainWidth,
  separatorWidth = 0,
  label,
  containerRef,
}: RightPanelResizeOptions) {
  // Persist the width the reader asked for and clamp only for rendering. A
  // panel can mount before its container has been laid out — the map frame does
  // exactly that — and storing the clamped value there would shrink the
  // remembered width to the minimum without anyone dragging anything.
  const [requestedWidth, setRequestedWidth] = useReviewUiState(
    stateKey,
    defaultWidth,
  );
  const [isResizing, setIsResizing] = useState(false);
  const [, setLayoutRevision] = useState(0);

  const containerMetrics = useCallback(() => {
    const rect = containerRef?.current?.getBoundingClientRect();
    // The width is clamped during render, which also happens during SSR where
    // there is no viewport to measure. An unbounded viewport there leaves the
    // requested width alone until the browser reports real geometry.
    const viewportWidth =
      typeof window === "undefined"
        ? Number.POSITIVE_INFINITY
        : window.innerWidth;
    return {
      right: rect?.right ?? viewportWidth,
      width: rect?.width ?? viewportWidth,
    };
  }, [containerRef]);

  const constrainWidth = useCallback(
    (nextWidth: number) => {
      const { width: containerWidth } = containerMetrics();
      const availableMax = Math.min(
        maxWidth,
        containerWidth - minMainWidth - separatorWidth,
      );
      return Math.min(
        Math.max(nextWidth, minWidth),
        Math.max(minWidth, availableMax),
      );
    },
    [containerMetrics, maxWidth, minMainWidth, minWidth, separatorWidth],
  );

  const width = constrainWidth(requestedWidth);

  const setWidth = useCallback(
    (nextWidth: number | ((width: number) => number)) => {
      setRequestedWidth((currentWidth) =>
        nextWidth instanceof Function
          ? nextWidth(constrainWidth(currentWidth))
          : nextWidth,
      );
    },
    [constrainWidth, setRequestedWidth],
  );

  // The Review canvas can shrink without the browser window changing when a
  // native Code OSS editor opens beside it. Observe the actual owning
  // container as well as the window so the document keeps its minimum width
  // in both layouts. The rendered width is derived, so a re-render is all this
  // needs; the requested width stays untouched and the panel returns to it once
  // there is room again.
  useEffect(() => {
    const reclampWidth = () => setLayoutRevision((revision) => revision + 1);
    window.addEventListener("resize", reclampWidth);
    const container = containerRef?.current;
    const resizeObserver =
      container && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(reclampWidth)
        : null;
    if (container && resizeObserver) resizeObserver.observe(container);
    return () => {
      window.removeEventListener("resize", reclampWidth);
      resizeObserver?.disconnect();
    };
  }, [containerRef]);

  const resizeFromClientX = useCallback(
    (clientX: number) => {
      const { right } = containerMetrics();
      setWidth(right - clientX);
    },
    [containerMetrics, setWidth],
  );

  const startResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsResizing(true);
      resizeFromClientX(event.clientX);
    },
    [resizeFromClientX],
  );

  const resize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isResizing) return;
      resizeFromClientX(event.clientX);
    },
    [isResizing, resizeFromClientX],
  );

  const stopResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizing(false);
  }, []);

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setWidth((currentWidth) => currentWidth + 32);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setWidth((currentWidth) => currentWidth - 32);
      }
    },
    [setWidth],
  );

  const separatorProps = useMemo<SeparatorProps>(
    () => ({
      role: "separator",
      "aria-label": label,
      "aria-orientation": "vertical",
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      "aria-valuenow": Math.round(width),
      tabIndex: 0,
      onPointerDown: startResize,
      onPointerMove: resize,
      onPointerUp: stopResize,
      onPointerCancel: stopResize,
      onLostPointerCapture: () => setIsResizing(false),
      onKeyDown: resizeWithKeyboard,
    }),
    [
      label,
      maxWidth,
      minWidth,
      resize,
      resizeWithKeyboard,
      startResize,
      stopResize,
      width,
    ],
  );

  return {
    width,
    setWidth,
    isResizing,
    separatorProps,
  };
}
