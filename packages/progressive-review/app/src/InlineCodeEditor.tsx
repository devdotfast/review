import type {
  ReviewDiffSide,
  ReviewFindQuery,
  ReviewInlineEditorHandle,
  ReviewInlineEditorHeightMode,
  ReviewInlineEditorRange,
} from "@dev.fast/review-protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useReviewSession } from "./host/review-session";
import { useReviewFindRegistration } from "./review-find";
import { useCompleteTutorialStep } from "./tutorial-context";

const LINE_HEIGHT = 20;
const MAX_VISIBLE_LINES = 18;
const INLINE_HEADER_HEIGHT = 40;

export function InlineCodeEditor({
  path,
  title,
  description,
  side,
  ranges,
  heightMode,
  diffStats,
  active,
  onFocus,
  onOpen,
  commentsEnabled = false,
  collapsed = false,
}: {
  path: string;
  title: string;
  description?: string;
  side: ReviewDiffSide;
  ranges: readonly ReviewInlineEditorRange[];
  heightMode: ReviewInlineEditorHeightMode;
  diffStats?: { additions: number; deletions: number };
  active: boolean;
  onFocus?: () => void;
  onOpen?: () => void;
  commentsEnabled?: boolean;
  collapsed?: boolean;
}) {
  const session = useReviewSession();
  const completeNavigation = useCompleteTutorialStep("gotoDefinition");
  const completeHover = useCompleteTutorialStep("showHover");
  const completeNavigationRef = useRef(completeNavigation);
  completeNavigationRef.current = completeNavigation;
  const handleNavigation = useCallback(
    () => completeNavigationRef.current?.(),
    [],
  );
  const completeHoverRef = useRef(completeHover);
  completeHoverRef.current = completeHover;
  const handleHover = useCallback(() => completeHoverRef.current?.(), []);
  const navigationObserverEnabled = completeNavigation !== undefined;
  const hoverObserverEnabled = completeHover !== undefined;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [shouldMount, setShouldMount] = useState(active);
  const [height, setHeight] = useState(() =>
    estimatedHeight(ranges, heightMode),
  );
  const rangesKey = ranges
    .map((range) => `${range.side ?? side}:${range.startLine}-${range.endLine}`)
    .join(",");
  const diffStatsKey = diffStats
    ? `${diffStats.additions}-${diffStats.deletions}`
    : "";
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<ReviewInlineEditorHandle | null>(null);
  const creationFailedRef = useRef(false);
  const latestFindQueryRef = useRef<ReviewFindQuery | null>(null);
  const handleWaitersRef = useRef<
    Array<(handle: ReviewInlineEditorHandle | null) => void>
  >([]);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const handleFocus = useCallback(() => onFocusRef.current?.(), []);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const handleOpen = useCallback(() => onOpenRef.current?.(), []);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const inlineEditorFactory = session.bridge.inlineEditors;
  const inlineEditorSessionId = session.config.sessionId;
  const reviewFind = useReviewFindRegistration();
  const ensureEditor = useCallback(async () => {
    if (handleRef.current) return handleRef.current;
    if (creationFailedRef.current) return null;
    setShouldMount(true);
    return new Promise<ReviewInlineEditorHandle | null>((resolve) => {
      handleWaitersRef.current.push(resolve);
    });
  }, []);
  const setFindQuery = useCallback(
    async (query: ReviewFindQuery) => {
      latestFindQueryRef.current = query;
      const handle = handleRef.current;
      if (handle) return handle.setFindQuery(query);
      return inlineEditorFactory.find(
        { path, side, ranges, commentsEnabled },
        query,
      );
    },
    [commentsEnabled, inlineEditorFactory, path, rangesKey, side],
  );
  const revealFindMatch = useCallback(
    async (index: number) => {
      const query = latestFindQueryRef.current;
      if (!query) return;
      const handle = await ensureEditor();
      if (!handle) return;
      await handle.setFindQuery(query);
      handle.revealFindMatch(index);
    },
    [ensureEditor],
  );
  const clearFind = useCallback(() => {
    latestFindQueryRef.current = null;
    handleRef.current?.clearFind();
  }, []);

  useLayoutEffect(() => {
    if (!container || !reviewFind) return;
    return reviewFind.register({
      container,
      setFindQuery,
      revealFindMatch,
      clearFind,
      getHandle: () => handleRef.current,
      expand: () => {
        container
          .closest(".review-section--collapsed")
          ?.dispatchEvent(new CustomEvent("review-section-expand"));
      },
    });
  }, [clearFind, container, revealFindMatch, reviewFind, setFindQuery]);

  useLayoutEffect(() => {
    if (active) setShouldMount(true);
  }, [active]);

  useLayoutEffect(() => {
    if (!container || shouldMount) return;
    // jsdom and legacy hosts lack IntersectionObserver; mounting eagerly
    // beats never mounting.
    if (typeof IntersectionObserver === "undefined") {
      setShouldMount(true);
      return;
    }
    // Mount a viewport-margin early so scrolling never reveals an empty host.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setShouldMount(true);
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, shouldMount]);

  useLayoutEffect(() => {
    if (!container || !shouldMount) return;
    setError(null);
    creationFailedRef.current = false;
    let handle: ReviewInlineEditorHandle;
    try {
      handle = inlineEditorFactory.create({
        container,
        path,
        title,
        description,
        side,
        ranges,
        heightMode,
        active,
        diffStats,
        onDidFocus: handleFocus,
        onDidOpen: handleOpen,
        onDidNavigate: navigationObserverEnabled ? handleNavigation : undefined,
        onDidShowHover: hoverObserverEnabled ? handleHover : undefined,
        commentsEnabled,
      });
    } catch (caught) {
      creationFailedRef.current = true;
      setError(caught instanceof Error ? caught.message : String(caught));
      for (const resolve of handleWaitersRef.current.splice(0)) resolve(null);
      return;
    }
    handle.setCollapsed(collapsedRef.current);
    handleRef.current = handle;
    for (const resolve of handleWaitersRef.current.splice(0)) resolve(handle);
    setHeight(handle.height);
    const findQuery = latestFindQueryRef.current;
    if (findQuery) void handle.setFindQuery(findQuery);
    const heightSubscription = handle.onDidChangeHeight(setHeight);
    const errorSubscription = handle.onDidError(setError);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      handle.clearFind();
      errorSubscription.dispose();
      heightSubscription.dispose();
      handle.dispose();
    };
  }, [
    container,
    commentsEnabled,
    description,
    diffStatsKey,
    handleFocus,
    handleHover,
    handleNavigation,
    handleOpen,
    heightMode,
    hoverObserverEnabled,
    inlineEditorFactory,
    inlineEditorSessionId,
    navigationObserverEnabled,
    path,
    rangesKey,
    shouldMount,
    side,
    title,
  ]);

  useLayoutEffect(() => {
    handleRef.current?.setActive(active);
  }, [active]);

  useLayoutEffect(() => {
    handleRef.current?.setCollapsed(collapsed);
  }, [collapsed]);

  useLayoutEffect(
    () => () => {
      for (const resolve of handleWaitersRef.current.splice(0)) resolve(null);
    },
    [],
  );

  return (
    <>
      <div
        ref={setContainer}
        className="review-inline-editor"
        data-review-inline-editor={path}
        data-review-inline-editor-active={active ? "true" : "false"}
        style={{ height }}
      />
      {error ? (
        <div className="review-inline-editor-error" title={error}>
          Inline preview unavailable
        </div>
      ) : null}
    </>
  );
}

function estimatedHeight(
  ranges: readonly ReviewInlineEditorRange[],
  heightMode: ReviewInlineEditorHeightMode,
): number {
  const lineCount = ranges.reduce((total, range) => {
    const contextBefore = Math.min(3, Math.max(0, range.startLine - 1));
    return total + range.endLine - range.startLine + 1 + contextBefore + 3;
  }, 0);
  const lines =
    heightMode === "content"
      ? lineCount
      : Math.min(MAX_VISIBLE_LINES, lineCount);
  return Math.max(1, lines) * LINE_HEIGHT + INLINE_HEADER_HEIGHT;
}
