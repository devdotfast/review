import {
  type CSSProperties,
  type ReactElement,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { ThreadTarget } from "../../src/types";
import {
  ANNOTATION_CONTAINER_SELECTOR,
  type CommentAnnotationPosition,
  PROSE_BLOCK_SELECTOR,
  commentAnnotationPositionsEqual,
} from "./comment-pins";
import { useReviewSession } from "./host/review-session";
import { CommentIcon } from "./icons";
import {
  type CommentDraftTarget,
  commentDraftTargetForSurface,
  isGlobalCommentDraft,
  useReviewActions,
  useReviewState,
} from "./review-context";
import { reviewDocumentRange } from "./review-document-text";
import { useReviewRoots } from "./review-root-context";
import {
  type ThreadView,
  commentThreadView,
  targetQuote,
} from "./review-threads";
import { targetKey, targetsEqual } from "./target-fingerprint";
import { ThreadCard, ThreadDraftCard } from "./thread-card";
import {
  buildLiveThreadTargetModel,
  useLiveAnchors,
  useLiveDiagrams,
} from "./thread-target-model";
import {
  type ThreadTargetState,
  resolveTargetState,
} from "./thread-target-state";
import { captureUiEvent } from "./ui-telemetry";

/** Single source for popover geometry; `.thread-popover` owns only its layer. */
const POPOVER_WIDTH = 420;
/** Narrowest margin card worth showing; below this the popover reads better. */
export const CARD_MIN_WIDTH = 266;
/**
 * Cards fill the gutter, so this only bites on very wide screens: a card
 * annotating the prose should never be wider than the prose itself.
 */
export const CARD_MAX_WIDTH = 720;
/** Space between the prose edge and the card column. */
const CARD_GUTTER_INSET = 18;
/**
 * Margin kept to the right of the card column so a filled card does not run up
 * against the window edge. Sized against the region's widest padding (52px), so
 * at the narrower breakpoints the card simply stops a little short of the
 * region's content edge.
 */
const CARD_GUTTER_TRAIL = 52;
/** Gutter (beyond the prose measure) needed before cards live in the margin. */
export const MARGIN_CARDS_MIN_GUTTER =
  CARD_MIN_WIDTH + CARD_GUTTER_INSET + CARD_GUTTER_TRAIL;
/** Gutter needed before compact markers render at the line's edge. */
const MARKER_MIN_GUTTER = 30;
const CARD_GAP = 10;

/** Rough mono advance at the card body's 12.5px size. */
const CARD_CHAR_WIDTH = 7.5;
export const CARD_BODY_LINE_HEIGHT = 19;
/** Author + timestamp row above each message. */
const CARD_MESSAGE_HEAD = 22;
/** Horizontal padding either side of the card's text. */
const CARD_BODY_PADDING = 14;
/** Card padding, quote and the reply composer. */
const CARD_CHROME_HEIGHT = 96;
/** A margin card renders in full when the whole thread fits in this height. */
const CARD_EXPANDED_FIT_HEIGHT = 420;

/**
 * Whether a thread is short enough to show in full in the margin.
 *
 * Short threads read better fully expanded — collapsing them only to have the
 * reader click for two more lines is noise. Long ones stay collapsed so a
 * single card cannot swallow the margin. This estimates rather than measures:
 * measuring means rendering both forms and swapping, which flickers on first
 * paint and can oscillate, since collapsing a card makes it fit again.
 */
export function threadFitsExpandedCard(
  bodies: readonly string[],
  width: number,
): boolean {
  const textWidth = width - 2 * CARD_BODY_PADDING;
  const charsPerLine = Math.max(1, Math.floor(textWidth / CARD_CHAR_WIDTH));
  let height = CARD_CHROME_HEIGHT;
  for (const body of bodies) {
    const lines = body
      .split("\n")
      .reduce(
        (count, line) =>
          count + Math.max(1, Math.ceil(line.length / charsPerLine)),
        0,
      );
    height += CARD_MESSAGE_HEAD + lines * CARD_BODY_LINE_HEIGHT;
  }
  return height <= CARD_EXPANDED_FIT_HEIGHT;
}

interface GutterInfo {
  mode: "cards" | "markers";
  left: number;
  width: number;
}

/**
 * Decide how threads present themselves given the gutter the layout leaves to
 * the right of the prose measure.
 *
 * `available` is measured from the prose's right edge to the review region's
 * right border edge, so it includes the region padding that
 * `--review-thread-gutter` reserves for this column (styles.css). Cards fill
 * whatever gutter there is, less the inset and trailing margin; at exactly
 * MARGIN_CARDS_MIN_GUTTER that lands on CARD_MIN_WIDTH, which is why the
 * threshold is derived from the width rather than stated separately. Below it,
 * threads fall back to markers plus the hover popover.
 */
export function gutterForAvailable(
  available: number,
  proseRight: number,
): GutterInfo {
  return available >= MARGIN_CARDS_MIN_GUTTER
    ? {
        mode: "cards",
        left: proseRight + CARD_GUTTER_INSET,
        width: Math.min(
          CARD_MAX_WIDTH,
          available - CARD_GUTTER_INSET - CARD_GUTTER_TRAIL,
        ),
      }
    : { mode: "markers", left: proseRight + 8, width: 0 };
}

/**
 * The document's thread layer: text highlights, plus — depending on how much
 * gutter the layout has — either Google-Docs-style ThreadCards stacked in
 * the right margin, or compact markers at the line's edge that open the same
 * card as a popover next to them. New-thread drafts render through the same
 * surfaces.
 */
export function ThreadAnnotations({
  articleRef,
  onThreadActivated,
  onOpenInPanel,
}: {
  articleRef: RefObject<HTMLElement | null>;
  onThreadActivated?: (threadId: string | null) => void;
  onOpenInPanel?: (thread: ThreadView) => void;
}): ReactElement | null {
  const session = useReviewSession();
  const {
    focusThread,
    blurThread,
    closeCommentDraft,
    clearThreadFocusRequest,
    askAgent: askAgentAction,
    saveComment,
  } = useReviewActions();
  const {
    allCommentThreads,
    draftTarget: contextDraftTarget,
    focusedThreadId,
    threadFocusRequest,
  } = useReviewState();
  const reviewRoots = useReviewRoots();
  const commentThreads = allCommentThreads();
  const draftTarget = isGlobalCommentDraft(contextDraftTarget)
    ? null
    : commentDraftTargetForSurface(contextDraftTarget, "document");
  const liveAnchors = useLiveAnchors();
  const liveDiagrams = useLiveDiagrams();
  const threads = useMemo(() => {
    const byKey = new Map<string, ThreadView>();
    for (const thread of commentThreads) {
      const view = commentThreadView(thread);
      byKey.set(view.key, view);
    }
    return byKey;
  }, [commentThreads]);

  const [annotations, setAnnotations] = useState<CommentAnnotationPosition[]>(
    [],
  );
  const [targetStates, setTargetStates] = useState<
    ReadonlyMap<string, ThreadTargetState>
  >(new Map());
  const displayThreads = useMemo(
    () =>
      new Map(
        [...threads].map(([threadId, thread]) => [
          threadId,
          { ...thread, targetState: targetStates.get(threadId) },
        ]),
      ),
    [targetStates, threads],
  );
  const [gutter, setGutter] = useState<GutterInfo | null>(null);
  const [preferredFocusedKey, setPreferredFocusedKey] = useState<string | null>(
    null,
  );
  const [cardTops, setCardTops] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftHasTextRef = useRef(false);

  // Recompute annotations when a draft opens/closes too, so the selected
  // text is highlighted while the comment is being written (not only after
  // it is submitted).
  // "inline" focus opens the thread's inline surface (expanded margin card /
  // popover); "highlight" focus (Threads-sidebar clicks) only scrolls to and
  // extra-highlights the anchor — the detail lives in the sidebar.
  const [focusPresentation, setFocusPresentation] = useState<
    "inline" | "highlight"
  >("inline");
  const activeKey = useMemo(() => {
    if (!focusedThreadId) return null;
    if (focusPresentation === "highlight") return null;
    if (preferredFocusedKey === focusedThreadId) return preferredFocusedKey;
    return displayThreads.has(focusedThreadId) ? focusedThreadId : null;
  }, [displayThreads, focusPresentation, focusedThreadId, preferredFocusedKey]);

  const activate = (annotation: { key: string; threadId: string }) => {
    captureUiEvent(session, "peek_opened", { via: "marker" });
    setFocusPresentation("inline");
    setPreferredFocusedKey(annotation.key);
    onThreadActivated?.(annotation.threadId);
    focusThread(annotation.threadId, { scroll: false });
    // Thread detail always opens in the side panel; the inline surfaces only
    // highlight the target and show the compact preview.
    const thread = displayThreads.get(annotation.key);
    if (thread) onOpenInPanel?.(thread);
  };

  const collapse = () => {
    blurThread();
    setPreferredFocusedKey(null);
    onThreadActivated?.(null);
  };

  const updateDraftHasText = (hasText: boolean) => {
    draftHasTextRef.current = hasText;
  };

  // The draft surface remounts when the gutter flips between cards and
  // markers (different containers); keep the typed text here so the new
  // composer can restore it.
  const draftTextRef = useRef("");
  const updateDraftText = (text: string) => {
    draftTextRef.current = text;
  };

  const closeDraftIfEmpty = () => {
    if (!draftTarget) return;
    const hasText =
      draftHasTextRef.current ||
      draftTextareaHasText(rootRef, reviewRoots?.appRef.current);
    if (!hasText) closeCommentDraft();
  };

  useEffect(() => {
    if (focusedThreadId) return;
    setPreferredFocusedKey(null);
  }, [focusedThreadId]);

  useEffect(() => {
    if (draftTarget) return;
    draftHasTextRef.current = false;
    draftTextRef.current = "";
  }, [draftTarget]);

  useEffect(() => {
    if (!draftTarget) return;
    const updateFromDom = () => {
      draftHasTextRef.current = draftTextareaHasText(rootRef);
    };
    updateFromDom();
    document.addEventListener("input", updateFromDom, true);
    return () => document.removeEventListener("input", updateFromDom, true);
  }, [draftTarget]);

  // Measure highlight/marker geometry and the available gutter.
  useLayoutEffect(() => {
    const article =
      articleRef.current ??
      document.querySelector<HTMLElement>(".review-document");
    if (!article) return;
    const region = article.closest(".review-view-region--review");

    let frame: number | null = null;
    let disposed = false;
    const placeAnnotations = () => {
      frame = null;
      if (disposed) return;
      const articleRect = article.getBoundingClientRect();
      const live = buildLiveThreadTargetModel(
        article,
        liveAnchors,
        liveDiagrams,
      );
      const commentStates = commentThreads.map((thread) => ({
        thread,
        state: resolveTargetState(thread, live),
      }));
      const nextTargetStates = new Map<string, ThreadTargetState>([
        ...commentStates.map(
          ({ thread, state }) => [thread.threadId, state] as const,
        ),
      ]);
      setTargetStates((current) =>
        targetStateMapsEqual(current, nextTargetStates)
          ? current
          : nextTargetStates,
      );
      const nextAnnotations = [
        ...commentStates.flatMap(({ thread, state }) =>
          state.state === "attached"
            ? annotationForThread(article, articleRect, state.target, {
                key: thread.threadId,
                threadId: thread.threadId,
                kind: "comment" as const,
                // The marker badge is the number of messages in this thread.
                index: thread.messages.length,
                status: thread.clientStatus,
              })
            : [],
        ),
        // Highlight the selection while a comment is being drafted. The draft
        // has no thread yet, so it renders as a highlight only (no marker /
        // margin card — the draft composer is its own surface).
        ...(draftTarget && draftTarget.target.kind === "text"
          ? annotationForThread(article, articleRect, draftTarget.target, {
              key: `draft:${draftTarget.threadId}`,
              threadId: draftTarget.threadId,
              kind: "comment" as const,
              index: 0,
              status: "draft" as const,
            }).map((annotation) => ({ ...annotation, marker: null }))
          : []),
      ].flat();
      setAnnotations((currentAnnotations) =>
        commentAnnotationPositionsEqual(currentAnnotations, nextAnnotations)
          ? currentAnnotations
          : nextAnnotations,
      );

      const regionRect = region?.getBoundingClientRect();
      const proseRight = proseRightEdge(article, articleRect, nextAnnotations);
      if (!regionRect || proseRight === null) {
        setGutter(null);
        return;
      }
      const available = regionRect.right - (articleRect.left + proseRight);
      const nextGutter = gutterForAvailable(available, proseRight);
      setGutter((current) =>
        current &&
        current.mode === nextGutter.mode &&
        current.left === nextGutter.left &&
        current.width === nextGutter.width
          ? current
          : nextGutter,
      );
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(placeAnnotations);
    };

    schedule();
    const followUps = [120, 500, 1200].map((delay) =>
      window.setTimeout(schedule, delay),
    );
    const mutationObserver = new MutationObserver((mutations) => {
      // Ignore mutations inside our own layer, which would loop forever.
      if (
        mutations.every((mutation) =>
          rootRef.current?.contains(mutation.target),
        )
      ) {
        return;
      }
      schedule();
    });
    mutationObserver.observe(article, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-review-locator"],
    });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(article);
    if (region) resizeObserver.observe(region);
    window.addEventListener("resize", placeAnnotations);
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      for (const timeout of followUps) window.clearTimeout(timeout);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", placeAnnotations);
    };
  }, [articleRef, draftTarget?.threadId, liveAnchors, liveDiagrams, threads]);

  // Cards change height while mounted (reply composer opening, text
  // wrapping, Read more) — watch them so the stacking pass reruns and
  // neighbors are pushed instead of overlapped.
  const [cardHeightsNonce, setCardHeightsNonce] = useState(0);
  useLayoutEffect(() => {
    if (gutter?.mode !== "cards") return;
    const observer = new ResizeObserver(() => {
      setCardHeightsNonce((nonce) => nonce + 1);
    });
    for (const node of cardRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [annotations, gutter?.mode]);

  // Stack margin cards: each sits at its anchor unless the previous card
  // pushes it down; the active card wins its anchor and pushes neighbors.
  useLayoutEffect(() => {
    if (gutter?.mode !== "cards") return;
    const entries = annotations
      .filter((annotation) => annotation.anchorY !== null)
      .sort((left, right) => (left.anchorY ?? 0) - (right.anchorY ?? 0));
    if (entries.length === 0) {
      setCardTops((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    const heights = new Map<string, number>();
    for (const entry of entries) {
      heights.set(
        entry.key,
        cardRefs.current.get(entry.key)?.offsetHeight ?? 76,
      );
    }
    const tops = new Map<string, number>();
    const activeIndex = entries.findIndex((entry) => entry.key === activeKey);
    const anchorOf = (index: number) => entries[index]?.anchorY ?? 0;
    if (activeIndex >= 0) {
      tops.set(entries[activeIndex]!.key, anchorOf(activeIndex));
      // Cards above the active one may only move up.
      let limit = anchorOf(activeIndex);
      for (let index = activeIndex - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        const height = heights.get(entry.key) ?? 76;
        const top = Math.min(anchorOf(index), limit - height - CARD_GAP);
        tops.set(entry.key, top);
        limit = top;
      }
      let cursor =
        anchorOf(activeIndex) +
        (heights.get(entries[activeIndex]!.key) ?? 76) +
        CARD_GAP;
      for (let index = activeIndex + 1; index < entries.length; index += 1) {
        const entry = entries[index]!;
        const top = Math.max(anchorOf(index), cursor);
        tops.set(entry.key, top);
        cursor = top + (heights.get(entry.key) ?? 76) + CARD_GAP;
      }
    } else {
      let cursor = -Infinity;
      for (const entry of entries) {
        const top = Math.max(entry.anchorY ?? 0, cursor);
        tops.set(entry.key, top);
        cursor = top + (heights.get(entry.key) ?? 76) + CARD_GAP;
      }
    }
    setCardTops((current) => {
      if (
        current.size === tops.size &&
        [...tops].every(([key, top]) => current.get(key) === top)
      ) {
        return current;
      }
      return tops;
    });
  }, [annotations, activeKey, cardHeightsNonce, displayThreads, gutter]);

  useEffect(() => {
    const request = threadFocusRequest;
    if (!request) return;
    let cancelled = false;
    const run = async () => {
      const article =
        articleRef.current ??
        document.querySelector<HTMLElement>(".review-document");
      if (!article) {
        clearThreadFocusRequest();
        return;
      }
      const thread = displayThreads.get(request.threadId) ?? null;
      let target = attachedTarget(thread);
      let targetElement = target ? elementForThread(article, target) : null;

      const hiddenContainer = targetElement?.closest("[hidden]");
      const section =
        hiddenContainer?.closest(".review-section") ??
        targetElement?.closest(".review-section--collapsed");
      if (section) {
        section.dispatchEvent(new CustomEvent("review-section-expand"));
        await nextAnimationFrame();
        if (cancelled) return;
        target = attachedTarget(thread);
        targetElement =
          (target ? elementForThread(article, target) : null) ?? targetElement;
      }

      if (cancelled) return;
      setFocusPresentation(request.inline ? "inline" : "highlight");
      const preferred = preferredFocusedKey
        ? displayThreads.get(preferredFocusedKey)
        : null;
      if (preferred?.threadId !== request.threadId) {
        setPreferredFocusedKey(request.inline ? (thread?.key ?? null) : null);
      }
      onThreadActivated?.(request.threadId);
      if (request.scroll && targetElement) {
        targetElement.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      // Thread detail lives in the side panel; a focus request only
      // highlights (and optionally scrolls to) the inline target.
      clearThreadFocusRequest();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    articleRef,
    onThreadActivated,
    preferredFocusedKey,
    clearThreadFocusRequest,
    threadFocusRequest,
    displayThreads,
  ]);

  // Escape collapses the active thread (composers stop propagation first).
  useEffect(() => {
    if (!focusedThreadId && !draftTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeDraftIfEmpty();
      collapse();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [draftTarget, focusedThreadId]);

  // Highlights are visual-only (pointer-events: none) so text under them
  // stays selectable; a click on highlighted text with no selection opens
  // the thread, Google-Docs style.
  useEffect(() => {
    const article =
      articleRef.current ??
      document.querySelector<HTMLElement>(".review-document");
    if (!article) return;
    const onClick = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          `a, button, ${ANNOTATION_CONTAINER_SELECTOR}, .thread-marker`,
        )
      ) {
        return;
      }
      const articleRect = article.getBoundingClientRect();
      const x = event.clientX - articleRect.left;
      const y = event.clientY - articleRect.top;
      const hit = annotations.find((annotation) =>
        annotation.rects.some(
          (rect) =>
            x >= rect.x &&
            x <= rect.x + rect.width &&
            y >= rect.y &&
            y <= rect.y + rect.height,
        ),
      );
      if (!hit) return;
      activate(hit);
    };
    article.addEventListener("click", onClick);
    return () => article.removeEventListener("click", onClick);
  }, [annotations, gutter]);

  // Focused threads and empty drafts collapse on outside pointer down.
  useEffect(() => {
    if (!focusedThreadId && !draftTarget) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".thread-popover")) return;
      if (target.closest(".review-annotations")) return;
      if (target.closest(".review-margin-threads")) return;
      if (target.closest(".review-floating-draft")) return;
      closeDraftIfEmpty();
      collapse();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [draftTarget, focusedThreadId]);

  const submitDraft = (askAgent: boolean, body: string) => {
    if (!draftTarget) return;
    const {
      draftSurface: _draftSurface,
      placement: _placement,
      title: _title,
      intent: _intent,
      ...input
    } = draftTarget;
    if (askAgent) {
      void askAgentAction({
        threadId: draftTarget.threadId,
        target: draftTarget.target,
        messageId: draftTarget.messageId,
        body,
      });
      closeCommentDraft();
      draftHasTextRef.current = false;
      setPreferredFocusedKey(draftTarget.threadId);
      focusThread(draftTarget.threadId);
      onThreadActivated?.(draftTarget.threadId);
      return;
    }
    void saveComment({ ...input, body }).then(() => {
      closeCommentDraft();
      draftHasTextRef.current = false;
      setPreferredFocusedKey(draftTarget.threadId);
      focusThread(draftTarget.threadId);
      onThreadActivated?.(draftTarget.threadId);
    });
  };

  const draftQuote = draftTarget
    ? (draftTarget.title ?? targetQuote(draftTarget.target))
    : "";
  const draftAnchorY = useMemo(() => {
    if (!draftTarget?.placement) return null;
    const article =
      articleRef.current ??
      document.querySelector<HTMLElement>(".review-document");
    if (!article) return null;
    return draftTarget.placement.y - article.getBoundingClientRect().top;
  }, [draftTarget, articleRef]);

  if (annotations.length === 0 && !draftTarget) return null;

  const marginCards =
    gutter?.mode === "cards"
      ? annotations.filter((annotation) => annotation.anchorY !== null)
      : [];
  const popoverHost = reviewRoots?.appRef.current ?? null;

  return (
    <div ref={rootRef}>
      <div className="review-annotations">
        {annotations.map((annotation) => {
          const isActive = annotation.key === activeKey;
          // The in-progress draft is always extra-highlighted — starting a
          // comment focuses its anchor, the same as clicking an existing one.
          const isDraft = annotation.key.startsWith("draft:");
          const isFocused = isDraft || annotation.threadId === focusedThreadId;
          const stateClasses =
            ` review-annotation--${annotation.kind}` +
            ` review-annotation--${annotation.status}` +
            (isActive ? " review-annotation--active" : "") +
            (isFocused ? " review-annotation--focused" : "");
          const showMarker =
            annotation.marker &&
            (gutter?.mode !== "cards" || annotation.anchorY === null);
          return (
            <span key={annotation.key}>
              {annotation.rects.map((rect, rectIndex) => (
                <div
                  key={rectIndex}
                  className={`review-highlight${stateClasses}`}
                  data-review-locator={annotation.targetKey}
                  style={{
                    left: rect.x,
                    top: rect.y,
                    width: rect.width,
                    height: rect.height,
                  }}
                />
              ))}
              {showMarker && annotation.marker && (
                <button
                  type="button"
                  className={`thread-marker${stateClasses}`}
                  data-review-locator={annotation.targetKey}
                  aria-label="Open comment thread"
                  onClick={() => activate(annotation)}
                  style={{
                    left: annotation.marker.x,
                    top: annotation.marker.y,
                  }}
                >
                  <CommentIcon />
                  {annotation.index > 1 && <span>{annotation.index}</span>}
                </button>
              )}
            </span>
          );
        })}
        {gutter?.mode !== "cards" &&
          draftTarget &&
          popoverHost &&
          createPortal(
            <div
              className="thread-popover"
              style={popoverStyle(
                draftPopoverPlacement(popoverHost, draftTarget),
              )}
            >
              <ThreadDraftCard
                quote={draftQuote}
                variant="popover"
                intent={draftTarget.intent}
                initialDraft={draftTextRef.current}
                onDraftStateChange={updateDraftHasText}
                onDraftTextChange={updateDraftText}
                onSubmitComment={(body) => submitDraft(false, body)}
                onAskAgent={(body) => submitDraft(true, body)}
                onCancel={() => closeCommentDraft()}
              />
            </div>,
            popoverHost,
          )}
      </div>
      {gutter?.mode === "cards" && (marginCards.length > 0 || draftTarget) && (
        <div
          className="review-margin-threads"
          style={{ left: gutter.left, width: gutter.width }}
        >
          {marginCards.map((annotation) => {
            const thread = displayThreads.get(annotation.key);
            if (!thread) return null;
            const isActive = annotation.key === activeKey;
            return (
              <div
                key={annotation.key}
                ref={(node) => {
                  if (node) cardRefs.current.set(annotation.key, node);
                  else cardRefs.current.delete(annotation.key);
                }}
                style={{
                  top: cardTops.get(annotation.key) ?? annotation.anchorY ?? 0,
                  // The active card paints above its neighbors so an
                  // expanding card never shows another card through it.
                  zIndex: isActive ? 2 : 1,
                }}
              >
                <ThreadCard
                  thread={thread}
                  variant="margin"
                  compact
                  onActivate={() => activate(annotation)}
                />
              </div>
            );
          })}
          {draftTarget && (
            <div style={{ top: Math.max(0, draftAnchorY ?? 0) }}>
              <ThreadDraftCard
                quote={draftQuote}
                variant="margin"
                intent={draftTarget.intent}
                initialDraft={draftTextRef.current}
                onDraftStateChange={updateDraftHasText}
                onDraftTextChange={updateDraftText}
                onSubmitComment={(body) => submitDraft(false, body)}
                onAskAgent={(body) => submitDraft(true, body)}
                onCancel={() => closeCommentDraft()}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function popoverStyle(placement: { x: number; y: number }): CSSProperties {
  return {
    position: "absolute",
    left: placement.x,
    top: placement.y,
    // Width lives here, not in `.thread-popover`, so it cannot drift from the
    // POPOVER_WIDTH the placement clamps are computed against.
    width: `min(${POPOVER_WIDTH}px, calc(100% - 24px))`,
    pointerEvents: "auto",
  };
}

function draftTextareaHasText(
  rootRef: RefObject<HTMLDivElement | null>,
  popoverHost?: HTMLElement | null,
): boolean {
  const selector = ".thread-card--draft textarea";
  const textarea =
    rootRef.current?.querySelector<HTMLTextAreaElement>(selector) ??
    popoverHost?.querySelector<HTMLTextAreaElement>(
      `.thread-popover ${selector}`,
    );
  return Boolean(textarea?.value.trim());
}

function attachedTarget(thread: ThreadView | null): ThreadTarget | null {
  return thread?.targetState?.state === "attached"
    ? thread.targetState.target
    : null;
}

function targetStateMapsEqual(
  left: ReadonlyMap<string, ThreadTargetState>,
  right: ReadonlyMap<string, ThreadTargetState>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([threadId, state]) => {
      const other = right.get(threadId);
      if (!other || state.state !== other.state) return false;
      if (state.state === "outdated" && other.state === "outdated") {
        return state.reason === other.reason;
      }
      return (
        state.state === "attached" &&
        other.state === "attached" &&
        targetsEqual(state.target, other.target)
      );
    })
  );
}

function draftPopoverPlacement(
  popoverHost: HTMLElement,
  draftTarget: CommentDraftTarget,
) {
  const hostRect = popoverHost.getBoundingClientRect();
  const viewportX = clamp(
    draftTarget.placement?.x ?? hostRect.left + hostRect.width / 2,
    hostRect.left + 12,
    Math.max(hostRect.left + 12, hostRect.right - POPOVER_WIDTH - 12),
  );
  const viewportY = clamp(
    draftTarget.placement?.y ?? 200,
    hostRect.top + 12,
    Math.max(hostRect.top + 12, hostRect.bottom - 200),
  );
  return {
    x: viewportX - hostRect.left,
    y: viewportY - hostRect.top,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function proseRightEdge(
  article: HTMLElement,
  articleRect: DOMRect,
  annotations: CommentAnnotationPosition[],
): number | null {
  const fromAnnotations = annotations
    .map((annotation) => annotation.blockRight)
    .filter((value): value is number => value !== null);
  if (fromAnnotations.length > 0) return Math.max(...fromAnnotations);
  const block = article.querySelector<HTMLElement>(
    `${PROSE_BLOCK_SELECTOR}, .review-section-body > *`,
  );
  if (!block) return null;
  return block.getBoundingClientRect().right - articleRect.left;
}

export function annotationForThread(
  article: HTMLElement,
  articleRect: DOMRect,
  target: ThreadTarget,
  base: {
    key: string;
    threadId: string;
    kind: CommentAnnotationPosition["kind"];
    index: number;
    status: CommentAnnotationPosition["status"];
  },
): CommentAnnotationPosition[] {
  const element = elementForThread(article, target);
  if (!element) return [];
  const fingerprint = targetKey(target);
  if (
    target.kind === "text" &&
    (target.surface.type === "document" ||
      target.surface.type === "block" ||
      target.surface.type === "table-cell") &&
    element instanceof HTMLElement &&
    !element.closest("[hidden]")
  ) {
    const geometry = textRangeClientGeometry(target, element);
    if (geometry) {
      const { blockRect, rects } = geometry;
      const firstRect = rects[0]!;
      const blockRight = blockRect.right - articleRect.left;
      const gutter = articleRect.right - blockRect.right;
      return [
        {
          ...base,
          targetKey: fingerprint,
          rects: rects.map((rect) => ({
            x: rect.left - articleRect.left,
            y: rect.top - articleRect.top,
            width: rect.width,
            height: rect.height,
          })),
          marker:
            gutter >= MARKER_MIN_GUTTER
              ? {
                  x: blockRight + 8,
                  y: firstRect.top - articleRect.top - 2,
                }
              : null,
          anchorY: firstRect.top - articleRect.top,
          blockRight,
        },
      ];
    }
  }
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return [];
  return [
    {
      ...base,
      targetKey: fingerprint,
      rects: [],
      marker: {
        x: rect.right - articleRect.left + 6,
        y: rect.top - articleRect.top - 8,
      },
      anchorY: rect.top - articleRect.top,
      blockRight: null,
    },
  ];
}

function elementForThread(
  article: HTMLElement,
  target: ThreadTarget,
): Element | null {
  const direct = [
    ...article.querySelectorAll(
      `[data-review-locator="${cssString(targetKey(target))}"]`,
    ),
  ].find((element) => !element.closest(ANNOTATION_CONTAINER_SELECTOR));
  if (direct) return direct;

  if (target.kind === "text" && target.surface.type === "document") {
    return article;
  }

  if (target.kind === "text" && target.surface.type === "anchor") {
    return article.querySelector(
      `[data-review-anchor-id="${cssString(target.surface.anchorId)}"]`,
    );
  }

  if (target.kind === "text" && target.surface.type === "block") {
    return article.querySelector(
      `[data-review-block-index="${target.surface.index}"]` +
        `[data-review-block-tag="${cssString(target.surface.tag)}"]`,
    );
  }

  if (target.kind === "text" && target.surface.type === "table-cell") {
    return article.querySelector(
      `[data-review-table="${target.surface.table}"]` +
        `[data-review-row="${target.surface.row}"]` +
        `[data-review-column="${target.surface.column}"]`,
    );
  }

  return null;
}

/**
 * Element to scroll into view for a focus request. Unlike elementForThread,
 * which must ignore the annotation overlays because it anchors measurement,
 * scrolling may land on the thread's own highlight: for a prose selection
 * that overlay is the only element marking where the thread lives.
 */
export function scrollTargetForThread(
  article: HTMLElement,
  target: ThreadTarget,
): Element | null {
  const anchored = elementForThread(article, target);
  if (anchored && anchored !== article) return anchored;
  const highlight = article.querySelector(
    `.review-annotations .review-highlight[data-review-locator="${cssString(targetKey(target))}"]`,
  );
  return highlight ?? null;
}

function textRange(
  target: Extract<ThreadTarget, { kind: "text" }>,
  element: HTMLElement,
): Range | null {
  const start = target.selection.start;
  if (target.surface.type === "document") {
    return reviewDocumentRange(element, start, start + target.selection.length);
  }
  const mapped = mapTextRange(element, start, start + target.selection.length);
  if (!mapped) return null;

  const range = document.createRange();
  range.setStart(mapped.start.node, mapped.start.offset);
  range.setEnd(mapped.end.node, mapped.end.offset);
  return range;
}

function textRangeClientGeometry(
  target: Extract<ThreadTarget, { kind: "text" }>,
  element: HTMLElement,
): { blockRect: DOMRect; rects: DOMRect[] } | null {
  const range = textRange(target, element);
  if (!range) return null;
  const { blocks, rects } = selectedTextGeometry(range, element);
  const blockRects = [...blocks].map((block) => block.getBoundingClientRect());
  const blockRect = blockRects.reduce(
    (rightmost, rect) => (rect.right > rightmost.right ? rect : rightmost),
    blockRects[0] ?? element.getBoundingClientRect(),
  );
  range.detach();
  return rects.length > 0 ? { blockRect, rects } : null;
}

/** Measure only selected text nodes, never fully enclosed block boxes. */
export function textNodeClientRects(
  range: Range,
  root: HTMLElement,
): DOMRect[] {
  return selectedTextGeometry(range, root).rects;
}

function selectedTextGeometry(range: Range, root: HTMLElement) {
  const blocks = new Set<HTMLElement>();
  const rects: DOMRect[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) {
      // SAFETY: the walker was created with NodeFilter.SHOW_TEXT, so every
      // node it yields is a Text.
      const textNode = node as Text;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end =
        node === range.endContainer ? range.endOffset : textNode.length;
      if (start < end) {
        const block =
          textNode.parentElement?.closest<HTMLElement>(PROSE_BLOCK_SELECTOR);
        if (block) blocks.add(block);
        const textRange = root.ownerDocument.createRange();
        textRange.setStart(textNode, start);
        textRange.setEnd(textNode, end);
        rects.push(
          ...[...textRange.getClientRects()].filter(
            (rect) => rect.width > 0 && rect.height > 0,
          ),
        );
        textRange.detach();
      }
    }
    node = walker.nextNode();
  }
  return { blocks, rects };
}

function mapTextRange(
  root: HTMLElement,
  start: number,
  end: number,
): {
  start: { node: Text; offset: number };
  end: { node: Text; offset: number };
} | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textIndex = 0;
  let mappedStart: { node: Text; offset: number } | null = null;
  let mappedEnd: { node: Text; offset: number } | null = null;

  while (walker.nextNode()) {
    // SAFETY: the walker was created with NodeFilter.SHOW_TEXT, so every node
    // it yields is a Text.
    const node = walker.currentNode as Text;
    const text = node.textContent ?? "";
    const nodeEnd = textIndex + text.length;
    if (!mappedStart && start >= textIndex && start <= nodeEnd) {
      mappedStart = { node, offset: start - textIndex };
    }
    if (!mappedEnd && end >= textIndex && end <= nodeEnd) {
      mappedEnd = { node, offset: end - textIndex };
    }
    textIndex = nodeEnd;
    if (mappedEnd) break;
  }

  const fallbackNode = mappedStart?.node;
  if (!mappedStart || !fallbackNode) return null;
  return {
    start: mappedStart,
    end: mappedEnd ?? { node: fallbackNode, offset: fallbackNode.length },
  };
}

function cssString(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
