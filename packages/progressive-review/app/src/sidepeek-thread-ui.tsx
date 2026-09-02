import {
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AnchorRef } from "../../src/authoring";
import type { SourceLineComment } from "../../src/source-code-types";
import type { ThreadTarget } from "../../src/types";
import {
  type OpenCommentDraftTarget,
  type ResolvedCommentCodeSource,
  commentDraftTargetForSurface,
  createClientId,
  useReview,
} from "./review-context";
import { useReviewRoots } from "./review-root-context";
import { commentThreadView, targetQuote } from "./review-threads";
import { readReviewUiState, writeReviewUiState } from "./review-ui-state";
import {
  buildCodeTarget,
  codeTargetProjectionSides,
  codeTargetResource,
  normalizeLineEndings,
  projectCodeTarget,
  resolvedCodeSurface,
} from "./target-fingerprint";
import { ThreadCard, ThreadDraftCard } from "./thread-card";
import { useResolvedBaseRef, useResolvedHeadRef } from "./thread-target-model";

export interface PanelLineRange {
  fromLine: number;
  toLine: number;
  side?: PanelSelectionSide;
}

export type PanelSelectionSide = "additions" | "deletions";

interface PanelSelectedLineRange {
  start: number;
  end: number;
  side?: PanelSelectionSide;
  endSide?: PanelSelectionSide;
}

export interface PanelThreadInjectionTarget {
  kind: "draft" | "thread";
  key: string;
  line: number;
  side?: PanelSelectionSide;
}

export interface PanelLineBadge {
  line: number;
  count: number;
  side?: PanelSelectionSide;
}

export interface PanelMeasuredLine {
  line: number;
  side?: PanelSelectionSide;
  top: number;
  height: number;
}

interface PanelViewportRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface PanelThreadRange extends PanelLineRange {
  threadId: string;
  count: number;
}

export type PanelThreadHost = "all" | "title" | "content";

export interface PanelThreadController {
  anchor: AnchorRef;
  sourceText?: string;
  sourceFromLine: number;
  sourceFile?: string;
  activeThreadId: string | null;
  activeRange: PanelLineRange | null;
  draftRange: PanelLineRange | null;
  dragRange: PanelLineRange | null;
  selectedRange: PanelLineRange | null;
  threadInjection: PanelThreadInjectionTarget | null;
  threadRanges: PanelThreadRange[];
  lineBadges: PanelLineBadge[];
  isBadgeActive: (line: number, side?: PanelSelectionSide) => boolean;
  activateLine: (line: number, side?: PanelSelectionSide) => void;
  activateThread: (threadId: string) => void;
  beginLineSelection: (range: PanelLineRange | null) => void;
  changeLineSelection: (range: PanelLineRange | null) => void;
  endLineSelection: (range: PanelLineRange | null) => void;
  renderThreadInjection: (
    target: PanelThreadInjectionTarget,
  ) => ReactElement | null;
  renderThreadArea: () => ReactElement | null;
  renderThreadFooter: () => ReactElement | null;
  renderTitleMarker: () => ReactElement | null;
}

const PANEL_THREAD_SECTION_SESSION_PREFIX = "review-sidepeek-comments";

export function panelThreadSectionSessionKey(
  pathname: string,
  anchorId: string,
  host: PanelThreadHost = "all",
): string {
  return `${PANEL_THREAD_SECTION_SESSION_PREFIX}:${pathname}:${anchorId}:${host}`;
}

export function readPanelThreadSectionCollapsed(key: string): boolean {
  return readReviewUiState<boolean>("window", key) === true;
}

export function writePanelThreadSectionCollapsed(
  key: string,
  collapsed: boolean,
): void {
  writeReviewUiState("window", key, collapsed);
}

export function groupLineCommentBadges(
  comments: readonly SourceLineComment[],
): PanelLineBadge[] {
  const counts = new Map<number, number>();
  for (const comment of comments) {
    counts.set(comment.line, (counts.get(comment.line) ?? 0) + comment.count);
  }
  return [...counts]
    .map(([line, count]) => ({ line, count }))
    .sort((left, right) => left.line - right.line);
}

function groupPanelThreadBadges(
  ranges: readonly PanelThreadRange[],
): PanelLineBadge[] {
  const counts = new Map<string, PanelLineBadge>();
  for (const range of ranges) {
    const key = `${range.side ?? "file"}:${range.fromLine}`;
    const current = counts.get(key);
    counts.set(key, {
      line: range.fromLine,
      count: (current?.count ?? 0) + range.count,
      ...(range.side ? { side: range.side } : {}),
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.line - right.line ||
      (left.side ?? "").localeCompare(right.side ?? ""),
  );
}

export function lineFromPointerY(
  rows: readonly Pick<PanelMeasuredLine, "line" | "top" | "height">[],
  pointerY: number,
): number | null {
  if (rows.length === 0) return null;
  const containing = rows.find(
    (row) => pointerY >= row.top && pointerY <= row.top + row.height,
  );
  if (containing) return containing.line;
  return rows.reduce((nearest, row) => {
    const rowCenter = row.top + row.height / 2;
    const nearestCenter = nearest.top + nearest.height / 2;
    return Math.abs(rowCenter - pointerY) < Math.abs(nearestCenter - pointerY)
      ? row
      : nearest;
  }).line;
}

export function panelMeasuredLinesEqual(
  left: readonly PanelMeasuredLine[],
  right: readonly PanelMeasuredLine[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.line === right[index]?.line &&
        row.side === right[index]?.side &&
        Math.abs(row.top - (right[index]?.top ?? 0)) < 0.5 &&
        Math.abs(row.height - (right[index]?.height ?? 0)) < 0.5,
    )
  );
}

export function normalizePanelLineRange(
  range: PanelSelectedLineRange | PanelLineRange | null,
): PanelLineRange | null {
  if (!range) return null;
  const first = "start" in range ? range.start : range.fromLine;
  const last = "end" in range ? range.end : range.toLine;
  const side = range.side ?? ("endSide" in range ? range.endSide : undefined);
  return {
    fromLine: Math.min(first, last),
    toLine: Math.max(first, last),
    ...(side ? { side } : {}),
  };
}

export function panelLineRangeLabel(range: PanelLineRange): string {
  return range.fromLine === range.toLine
    ? `L${range.fromLine}`
    : `L${range.fromLine}–${range.toLine}`;
}

export function panelThreadInjectionTarget(input: {
  draft: { threadId: string; range: PanelLineRange } | null;
  expandedThread: { threadId: string; range: PanelLineRange } | null;
}): PanelThreadInjectionTarget | null {
  if (input.draft) {
    return {
      kind: "draft",
      key: `draft:${input.draft.threadId}`,
      line: input.draft.range.toLine,
      ...(input.draft.range.side ? { side: input.draft.range.side } : {}),
    };
  }
  if (input.expandedThread) {
    return {
      kind: "thread",
      key: `thread:${input.expandedThread.threadId}`,
      line: input.expandedThread.range.toLine,
      ...(input.expandedThread.range.side
        ? { side: input.expandedThread.range.side }
        : {}),
    };
  }
  return null;
}

export function panelDraftDismissalAction(
  trigger: "outside-pointer" | "escape",
  hasText: boolean,
): "blur" | "close" | "keep" {
  if (!hasText) return "close";
  return trigger === "escape" ? "blur" : "keep";
}

export function panelEscapeAction(input: {
  menuOpen: boolean;
  draftHasText: boolean | null;
  threadExpanded: boolean;
}):
  | "close-menu"
  | "close-draft"
  | "blur-draft"
  | "minimize-thread"
  | "close-panel" {
  if (input.menuOpen) return "close-menu";
  if (input.draftHasText !== null) {
    return input.draftHasText ? "blur-draft" : "close-draft";
  }
  if (input.threadExpanded) return "minimize-thread";
  return "close-panel";
}

function panelThreadMenuIsOpen(root: Element | null | undefined): boolean {
  return root?.querySelector('.side-panel .thread-card [role="menu"]') != null;
}

export function panelThreadCardNeedsScroll(
  card: PanelViewportRect,
  viewport: PanelViewportRect,
): boolean {
  return (
    card.top < viewport.top ||
    card.right > viewport.right ||
    card.bottom > viewport.bottom ||
    card.left < viewport.left
  );
}

export function codeTargetLineRange(
  target: ThreadTarget,
  _anchorId: string,
  sourceText: string,
  sourceFromLine: number,
  side: "base" | "head" = "head",
  patch?: string,
): PanelLineRange | null {
  if (target.kind !== "code") return null;
  const projection = projectCodeTarget(target, side, patch);
  if (!projection) return null;
  const lastLine =
    sourceFromLine + normalizeLineEndings(sourceText).split("\n").length - 1;
  if (
    projection.span.startLine < sourceFromLine ||
    projection.span.endLine > lastLine
  ) {
    return null;
  }
  return {
    fromLine: projection.span.startLine,
    toLine: projection.span.endLine,
    side: side === "base" ? "deletions" : "additions",
  };
}

function diffFileForCodeTarget(anchor: AnchorRef, target: ThreadTarget) {
  return target.kind === "code"
    ? anchor.peek?.resolution?.diff?.files.find(
        (file) =>
          file.path === target.position.new_path ||
          file.previousPath === target.position.old_path,
      )
    : undefined;
}

export function panelThreadHostForTarget(
  target: ThreadTarget,
  anchorId: string,
): Exclude<PanelThreadHost, "all"> | null {
  if (target.kind === "code") return "content";
  if (
    target.kind !== "text" ||
    target.surface.type !== "anchor" ||
    target.surface.anchorId !== anchorId
  )
    return null;
  return target.surface.part.field === "title" ? "title" : "content";
}

export function buildAuthoredCodeLineTarget(
  input: {
    path: string;
    side: "base" | "head";
    baseCommit: string;
    headCommit: string;
  },
  range: PanelLineRange,
): OpenCommentDraftTarget {
  return {
    target: buildCodeTarget({
      path: input.path,
      side: input.side,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      span: {
        startLine: range.fromLine,
        endLine: range.toLine,
      },
    }),
    title: panelLineRangeLabel(range),
    body: "",
  };
}

export function usePanelThreadController({
  anchor,
  sourceText,
  sourceFromLine = 1,
  sourceFile,
  sourceCommit,
  createLineTarget,
  resolveBaseSource,
  threadHost = "all",
}: {
  anchor: AnchorRef;
  sourceText?: string;
  sourceFromLine?: number;
  sourceFile?: string;
  sourceCommit?: string;
  createLineTarget?: (range: PanelLineRange) => OpenCommentDraftTarget;
  resolveBaseSource?: () => Promise<ResolvedCommentCodeSource>;
  threadHost?: PanelThreadHost;
}): PanelThreadController {
  const appRef = useReviewRoots()?.appRef;
  const review = useReview();
  const comments = review
    .commentsForAnchor(anchor)
    .filter(
      (thread) =>
        threadHost === "all" ||
        panelThreadHostForTarget(thread.target, anchor.id) === threadHost,
    );
  const openComments = comments.filter(
    (thread) => thread.status !== "resolved",
  );
  const resolvedComments = comments.filter(
    (thread) => thread.status === "resolved",
  );
  const panelDraftTarget = commentDraftTargetForSurface(
    review.draftTarget,
    "panel",
  );
  const defaultCodeSide =
    anchor.peek?.resolution?.diff?.orientation ??
    anchor.peek?.props.graph ??
    "head";
  const draftCodeResource =
    panelDraftTarget?.target.kind === "code"
      ? codeTargetResource(panelDraftTarget.target, defaultCodeSide)
      : null;
  const draftTarget =
    panelDraftTarget &&
    ((panelDraftTarget.target.kind === "code" &&
      draftCodeResource?.path === sourceFile &&
      draftCodeResource?.commit === sourceCommit) ||
      (panelDraftTarget.target.kind === "text" &&
        panelDraftTarget.target.surface.type === "anchor" &&
        panelDraftTarget.target.surface.anchorId === anchor.id)) &&
    (threadHost === "all" ||
      panelThreadHostForTarget(panelDraftTarget.target, anchor.id) ===
        threadHost)
      ? panelDraftTarget
      : null;
  const storageKey = panelThreadSectionSessionKey(
    typeof window === "undefined" ? "" : window.location.pathname,
    anchor.id,
    threadHost,
  );
  const [sectionCollapsed, setSectionCollapsed] = useState(() =>
    readPanelThreadSectionCollapsed(storageKey),
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);
  const [dragRange, setDragRange] = useState<PanelLineRange | null>(null);
  const [baseSource, setBaseSource] =
    useState<ResolvedCommentCodeSource | null>(null);
  const [baseSourceError, setBaseSourceError] = useState<string | null>(null);
  const [draftSubmitError, setDraftSubmitError] = useState<string | null>(null);
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  const draftCardRef = useRef<HTMLElement | null>(null);
  const draftHasTextRef = useRef(false);

  const needsBaseSource = comments.some(
    (thread) =>
      thread.target.kind === "code" &&
      codeTargetProjectionSides(thread.target, defaultCodeSide).includes(
        "base",
      ),
  );

  useEffect(() => {
    if (!needsBaseSource || !resolveBaseSource || baseSource) return;
    let cancelled = false;
    setBaseSourceError(null);
    void resolveBaseSource().then(
      (source) => {
        if (!cancelled) setBaseSource(source);
      },
      (error: unknown) => {
        if (!cancelled) {
          setBaseSourceError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [baseSource, needsBaseSource, resolveBaseSource]);

  const threadRanges = useMemo<PanelThreadRange[]>(() => {
    return openComments.flatMap((thread) => {
      if (thread.target.kind !== "code") return [];
      const patch = diffFileForCodeTarget(anchor, thread.target)?.patch;
      return codeTargetProjectionSides(thread.target, defaultCodeSide).flatMap(
        (side) => {
          const source =
            side === "base"
              ? baseSource
              : sourceText === undefined
                ? null
                : { text: sourceText, fromLine: sourceFromLine };
          if (!source) return [];
          const range = codeTargetLineRange(
            thread.target,
            anchor.id,
            source.text,
            source.fromLine,
            side,
            patch,
          );
          return range
            ? [
                {
                  ...range,
                  threadId: thread.threadId,
                  count: thread.messages.length,
                },
              ]
            : [];
        },
      );
    });
  }, [
    anchor,
    baseSource,
    defaultCodeSide,
    openComments,
    sourceFromLine,
    sourceText,
  ]);
  const activeThread =
    openComments.find((thread) => thread.threadId === activeThreadId) ?? null;
  const activeRange =
    threadRanges.find((range) => range.threadId === activeThreadId) ?? null;
  const draftRange = draftTarget?.panelRange
    ? normalizePanelLineRange(draftTarget.panelRange)
    : draftTarget
      ? (() => {
          if (draftTarget.target.kind !== "code") return null;
          const side = codeTargetProjectionSides(
            draftTarget.target,
            defaultCodeSide,
          )[0];
          if (!side) return null;
          const source =
            side === "base"
              ? baseSource
              : sourceText === undefined
                ? null
                : { text: sourceText, fromLine: sourceFromLine };
          return source
            ? codeTargetLineRange(
                draftTarget.target,
                anchor.id,
                source.text,
                source.fromLine,
                side,
                diffFileForCodeTarget(anchor, draftTarget.target)?.patch,
              )
            : null;
        })()
      : null;
  const lineBadges = groupPanelThreadBadges(threadRanges);
  const selectedRange = dragRange ?? draftRange ?? activeRange;
  const threadInjection = panelThreadInjectionTarget({
    draft:
      draftTarget && draftRange
        ? { threadId: draftTarget.threadId, range: draftRange }
        : null,
    expandedThread:
      activeThread && activeRange
        ? { threadId: activeThread.threadId, range: activeRange }
        : null,
  });

  const setCollapsed = (collapsed: boolean) => {
    setSectionCollapsed(collapsed);
    writePanelThreadSectionCollapsed(storageKey, collapsed);
  };

  const activateThread = (threadId: string) => {
    setCollapsed(false);
    setActiveThreadId(threadId);
    review.focusThread(threadId, { scroll: false });
  };

  const activateLine = (line: number, side?: PanelSelectionSide) => {
    const matching = threadRanges.find(
      (range) =>
        line >= range.fromLine &&
        line <= range.toLine &&
        (!side || !range.side || range.side === side),
    );
    if (matching) activateThread(matching.threadId);
  };

  const minimize = () => {
    setActiveThreadId(null);
    review.blurThread();
  };

  const endLineSelection = (range: PanelLineRange | null) => {
    const normalized = normalizePanelLineRange(range);
    setDragRange(null);
    if (!normalized || !createLineTarget) return;
    setCollapsed(false);
    setActiveThreadId(null);
    review.openCommentDraft({
      ...createLineTarget(normalized),
      draftSurface: "panel",
    });
  };

  useEffect(() => {
    draftHasTextRef.current = false;
    setDraftSubmitError(null);
    if (!draftTarget) return;
    setCollapsed(false);
    setActiveThreadId(null);
  }, [draftTarget?.threadId]);

  useEffect(() => {
    if (!activeThreadId || activeThread) return;
    setActiveThreadId(null);
  }, [activeThread, activeThreadId]);

  useLayoutEffect(() => {
    if (sectionCollapsed) return;
    const card = draftTarget ? draftCardRef.current : activeCardRef.current;
    if (!card) return;
    const scroller = card.closest<HTMLElement>(".side-peek-body");
    const viewport = scroller?.getBoundingClientRect() ?? {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    };
    if (!panelThreadCardNeedsScroll(card.getBoundingClientRect(), viewport)) {
      return;
    }
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeThreadId, draftTarget?.threadId, sectionCollapsed]);

  useEffect(() => {
    if (!draftTarget) return;
    const closeEmptyDraftOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        const element =
          target instanceof Element ? target : target.parentElement;
        if (
          draftCardRef.current?.contains(target) ||
          element?.closest(".thread-card--draft")
        ) {
          return;
        }
      }
      if (
        panelDraftDismissalAction(
          "outside-pointer",
          draftHasTextRef.current,
        ) === "close"
      ) {
        review.closeCommentDraft();
      }
    };
    const handleDraftEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const action = panelEscapeAction({
        menuOpen: panelThreadMenuIsOpen(appRef?.current),
        draftHasText: draftHasTextRef.current,
        threadExpanded: false,
      });
      if (action === "close-menu") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "close-draft") {
        review.closeCommentDraft();
        return;
      }
      draftCardRef.current?.querySelector("textarea")?.blur();
    };
    document.addEventListener(
      "pointerdown",
      closeEmptyDraftOnOutsidePointer,
      true,
    );
    document.addEventListener("keydown", handleDraftEscape, true);
    return () => {
      document.removeEventListener(
        "pointerdown",
        closeEmptyDraftOnOutsidePointer,
        true,
      );
      document.removeEventListener("keydown", handleDraftEscape, true);
    };
  }, [appRef, draftTarget?.threadId, review]);

  useEffect(() => {
    if (!activeThreadId) return;
    const collapseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const action = panelEscapeAction({
        menuOpen: panelThreadMenuIsOpen(appRef?.current),
        draftHasText: null,
        threadExpanded: true,
      });
      if (action !== "minimize-thread") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      minimize();
    };
    document.addEventListener("keydown", collapseOnEscape, true);
    return () =>
      document.removeEventListener("keydown", collapseOnEscape, true);
  }, [activeThreadId, appRef]);

  const submitDraft = async (
    askAgent: boolean,
    body: string,
  ): Promise<boolean> => {
    if (!draftTarget) return false;
    const { resolveTarget } = draftTarget;
    setDraftSubmitError(null);
    try {
      const target = resolveTarget ? await resolveTarget() : draftTarget.target;
      if (askAgent) {
        await review.askAgent({
          threadId: draftTarget.threadId,
          target,
          messageId: draftTarget.messageId,
          body,
        });
        review.closeCommentDraft();
        return true;
      }
      await review.saveComment({
        threadId: draftTarget.threadId,
        target,
        messageId: draftTarget.messageId,
        body,
      });
      review.closeCommentDraft();
      return true;
    } catch (error) {
      setDraftSubmitError(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  };

  const renderActiveThreadCard = (): ReactElement | null => {
    if (!activeThread) return null;
    return (
      <div ref={activeCardRef} className="panel-thread-active-card">
        <ThreadCard
          thread={{
            ...commentThreadView(activeThread),
            quote: activeRange
              ? panelLineRangeLabel(activeRange)
              : targetQuote(activeThread.target),
          }}
          variant="panel"
          quoteKind={activeRange ? "line" : "text"}
          onMinimize={minimize}
          onResolve={(resolved) => {
            void review.setCommentResolved(activeThread.threadId, resolved);
            if (resolved) minimize();
          }}
          onAskNow={(body) =>
            review.askAgent({
              threadId: activeThread.threadId,
              messageId: createClientId(),
              target: activeThread.target,
              body,
            })
          }
          onAddToReview={(body) =>
            review.saveComment({
              threadId: activeThread.threadId,
              messageId: createClientId(),
              target: activeThread.target,
              body,
            })
          }
          onEditMessage={(messageId, body) =>
            review.updateComment(activeThread.threadId, body, messageId)
          }
          onDeleteMessage={(messageId) =>
            review.deleteCommentMessage(activeThread.threadId, messageId)
          }
          onDelete={() => {
            minimize();
            return review.deleteComment(activeThread.threadId);
          }}
        />
      </div>
    );
  };

  const renderDraftCard = (): ReactElement | null => {
    if (!draftTarget) return null;
    const draftQuote = draftRange
      ? panelLineRangeLabel(draftRange)
      : (draftTarget.title ?? targetQuote(draftTarget.target));
    return (
      <ThreadDraftCard
        cardRef={draftCardRef}
        quote={draftQuote}
        quoteKind={draftRange ? "line" : "text"}
        variant="panel"
        intent={draftTarget.intent}
        onSubmitComment={(body) => submitDraft(false, body)}
        onAskAgent={(body) => submitDraft(true, body)}
        error={draftSubmitError}
        onCancel={review.closeCommentDraft}
        onDraftStateChange={(hasText) => {
          draftHasTextRef.current = hasText;
        }}
      />
    );
  };

  const renderThreadInjection = (
    target: PanelThreadInjectionTarget,
  ): ReactElement | null => {
    if (target.key !== threadInjection?.key) return null;
    return (
      <div
        className="panel-thread-injected-row"
        data-panel-thread-injection={target.kind}
      >
        {target.kind === "draft" ? renderDraftCard() : renderActiveThreadCard()}
      </div>
    );
  };

  const renderThreadArea = (): ReactElement | null => {
    if (sectionCollapsed) return null;
    const unbadgedThreads = openComments.filter(
      (thread) =>
        !threadRanges.some((range) => range.threadId === thread.threadId),
    );
    const hasCards =
      (unbadgedThreads.length > 0 && !activeThread) ||
      Boolean(activeThread && !activeRange) ||
      Boolean(draftTarget && !draftRange) ||
      (resolvedExpanded && resolvedComments.length > 0);
    if (!hasCards) return null;

    return (
      <section className="panel-thread-area" aria-label="Comment threads">
        {unbadgedThreads.length > 0 && !activeThread ? (
          <div className="panel-thread-compact-list">
            {unbadgedThreads.map((thread) => (
              <ThreadCard
                key={thread.threadId}
                thread={commentThreadView(thread)}
                variant="panel"
                compact
                onActivate={() => activateThread(thread.threadId)}
              />
            ))}
          </div>
        ) : null}
        {activeThread && !activeRange ? renderActiveThreadCard() : null}
        {draftTarget && !draftRange ? renderDraftCard() : null}
        {baseSourceError ? (
          <div className="panel-thread-source-error" role="alert">
            {baseSourceError}
          </div>
        ) : null}
        {resolvedExpanded ? (
          <div className="panel-resolved-list">
            {resolvedComments.map((thread) => {
              const side =
                thread.target.kind === "code"
                  ? codeTargetProjectionSides(thread.target, defaultCodeSide)[0]
                  : undefined;
              const rangeSource =
                side === "base"
                  ? baseSource
                  : side === "head" && sourceText !== undefined
                    ? { text: sourceText, fromLine: sourceFromLine }
                    : null;
              const range = rangeSource
                ? codeTargetLineRange(
                    thread.target,
                    anchor.id,
                    rangeSource.text,
                    rangeSource.fromLine,
                    side,
                    diffFileForCodeTarget(anchor, thread.target)?.patch,
                  )
                : null;
              return (
                <article key={thread.threadId} className="panel-resolved-card">
                  <span
                    className={
                      range ? "panel-thread-line-chip" : "panel-resolved-quote"
                    }
                  >
                    {range
                      ? panelLineRangeLabel(range)
                      : targetQuote(thread.target)}
                  </span>
                  <p>{thread.messages[0]?.body}</p>
                  <button
                    type="button"
                    onClick={() =>
                      void review.setCommentResolved(thread.threadId, false)
                    }
                  >
                    Reopen
                  </button>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  };

  const renderThreadFooter = (): ReactElement | null => {
    const hasContent =
      openComments.length > 0 ||
      resolvedComments.length > 0 ||
      Boolean(draftTarget);
    if (!hasContent) return null;
    if (threadHost === "title" && sectionCollapsed) return null;
    if (threadHost === "title") {
      return resolvedComments.length > 0 ? (
        <section className="panel-thread-footer" aria-label="Comment controls">
          <div className="panel-resolved-section">
            <button
              type="button"
              className="panel-resolved-disclosure"
              aria-expanded={resolvedExpanded}
              onClick={() => setResolvedExpanded((expanded) => !expanded)}
            >
              <span>✓ Resolved · {resolvedComments.length}</span>
              <span aria-hidden="true">{resolvedExpanded ? "▾" : "▸"}</span>
            </button>
          </div>
        </section>
      ) : null;
    }
    if (sectionCollapsed) {
      return (
        <button
          type="button"
          className="panel-thread-section-rail"
          onClick={() => setCollapsed(false)}
        >
          <span>
            Comments {openComments.length} · Resolved {resolvedComments.length}
          </span>
          <span aria-hidden="true">▸</span>
        </button>
      );
    }

    return (
      <section className="panel-thread-footer" aria-label="Comment controls">
        <header className="panel-thread-section-header">
          <span>Comments {openComments.length}</span>
          <button
            type="button"
            className="panel-thread-quiet-button"
            aria-label="Collapse comment section"
            title="Collapse comment section"
            onClick={() => setCollapsed(true)}
          >
            <span aria-hidden="true">−</span>
          </button>
        </header>
        {resolvedComments.length > 0 ? (
          <div className="panel-resolved-section">
            <button
              type="button"
              className="panel-resolved-disclosure"
              aria-expanded={resolvedExpanded}
              onClick={() => setResolvedExpanded((expanded) => !expanded)}
            >
              <span>✓ Resolved · {resolvedComments.length}</span>
              <span aria-hidden="true">{resolvedExpanded ? "▾" : "▸"}</span>
            </button>
          </div>
        ) : null}
      </section>
    );
  };

  const renderTitleMarker = (): ReactElement | null => {
    if (threadHost !== "title") return null;
    const hasContent =
      openComments.length > 0 ||
      resolvedComments.length > 0 ||
      Boolean(draftTarget);
    if (!hasContent) return null;
    return (
      <button
        type="button"
        className="panel-title-thread-marker"
        aria-expanded={!sectionCollapsed}
        onClick={() => setCollapsed(!sectionCollapsed)}
      >
        <span>Comments {openComments.length + (draftTarget ? 1 : 0)}</span>
        <span aria-hidden="true">{sectionCollapsed ? "▸" : "−"}</span>
      </button>
    );
  };

  return {
    anchor,
    sourceText,
    sourceFromLine,
    sourceFile,
    activeThreadId,
    activeRange,
    draftRange,
    dragRange,
    selectedRange,
    threadInjection,
    threadRanges,
    lineBadges,
    isBadgeActive: (line, side) =>
      threadRanges.some(
        (range) =>
          range.threadId === activeThreadId &&
          range.fromLine === line &&
          (!side || !range.side || range.side === side),
      ),
    activateLine,
    activateThread,
    beginLineSelection: setDragRange,
    changeLineSelection: setDragRange,
    endLineSelection,
    renderThreadInjection,
    renderThreadArea,
    renderThreadFooter,
    renderTitleMarker,
  };
}

export interface PanelCodeLine {
  key: string;
  line: number;
  side?: PanelSelectionSide;
  text: string;
  marker?: string;
}

export function PanelCodeSurface({
  lines,
  controller,
  className,
  language,
  selectionStamp,
}: {
  lines: readonly PanelCodeLine[];
  controller: PanelThreadController;
  className?: string;
  language?: string;
  selectionStamp?: Record<string, string>;
}): ReactElement {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const dragAnchorRef = useRef<PanelLineRange | null>(null);
  const dragRangeRef = useRef<PanelLineRange | null>(null);
  const [rows, setRows] = useState<PanelMeasuredLine[]>([]);
  const [injectionGeometry, setInjectionGeometry] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const measureRows = () => {
    const layout = layoutRef.current;
    if (!layout) return;
    const layoutRect = layout.getBoundingClientRect();
    const elements = [
      ...layout.querySelectorAll<HTMLElement>("[data-panel-code-line]"),
    ];
    const nextRows = controller.lineBadges.flatMap((badge) => {
      const element = elements.find(
        (candidate) =>
          Number(candidate.dataset.line) === badge.line &&
          (!badge.side || candidate.dataset.lineSide === badge.side),
      );
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return [
        {
          line: badge.line,
          side: badge.side,
          top: rect.top - layoutRect.top,
          height: rect.height,
        },
      ];
    });
    setRows((current) =>
      panelMeasuredLinesEqual(current, nextRows) ? current : nextRows,
    );
    const injection = controller.threadInjection;
    const injectionElement = injection
      ? elements.find(
          (candidate) =>
            Number(candidate.dataset.line) === injection.line &&
            (!injection.side || candidate.dataset.lineSide === injection.side),
        )
      : undefined;
    if (!injectionElement) {
      setInjectionGeometry(null);
      return;
    }
    const rect = injectionElement.getBoundingClientRect();
    const nextGeometry = {
      top: rect.bottom - layoutRect.top,
      left: rect.left - layoutRect.left,
      width: rect.width,
    };
    setInjectionGeometry((current) =>
      current &&
      Math.abs(current.top - nextGeometry.top) < 0.5 &&
      Math.abs(current.left - nextGeometry.left) < 0.5 &&
      Math.abs(current.width - nextGeometry.width) < 0.5
        ? current
        : nextGeometry,
    );
  };

  useLayoutEffect(measureRows, [
    controller.activeThreadId,
    controller.dragRange,
    controller.threadInjection?.key,
    controller.threadRanges,
    lines,
  ]);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRows);
    observer.observe(layout);
    return () => observer.disconnect();
  }, [lines]);

  useEffect(() => {
    const finishSelection = () => {
      const range = dragRangeRef.current;
      if (!range) return;
      dragAnchorRef.current = null;
      dragRangeRef.current = null;
      controller.endLineSelection(range);
    };
    window.addEventListener("pointerup", finishSelection);
    return () => window.removeEventListener("pointerup", finishSelection);
  }, [controller]);

  const beginSelection = (
    event: ReactPointerEvent<HTMLButtonElement>,
    line: PanelCodeLine,
  ) => {
    event.preventDefault();
    const range = {
      fromLine: line.line,
      toLine: line.line,
      ...(line.side ? { side: line.side } : {}),
    };
    dragAnchorRef.current = range;
    dragRangeRef.current = range;
    controller.beginLineSelection(range);
  };
  const extendSelection = (
    event: ReactPointerEvent<HTMLButtonElement>,
    line: PanelCodeLine,
  ) => {
    const anchor = dragAnchorRef.current;
    if (!anchor || event.buttons !== 1) return;
    if (anchor.side && line.side && anchor.side !== line.side) return;
    const range = {
      fromLine: Math.min(anchor.fromLine, line.line),
      toLine: Math.max(anchor.toLine, line.line),
      ...(anchor.side || line.side ? { side: anchor.side ?? line.side } : {}),
    };
    dragRangeRef.current = range;
    controller.changeLineSelection(range);
  };

  return (
    <>
      <div className="panel-code-block-with-rail" ref={layoutRef}>
        <pre
          className={["panel-static-code-surface", className]
            .filter(Boolean)
            .join(" ")}
          data-language={language}
          {...selectionStamp}
        >
          {lines.map((line) => {
            return (
              <span className="panel-static-code-entry" key={line.key}>
                <span
                  className="panel-static-code-line"
                  data-panel-code-line=""
                  data-line={line.line}
                  data-line-side={line.side}
                  data-panel-thread-highlight={panelCodeLineHighlight(
                    line,
                    controller,
                  )}
                  onClick={() => controller.activateLine(line.line, line.side)}
                >
                  <button
                    type="button"
                    className="panel-static-code-gutter"
                    aria-label={`Comment on line ${line.line}`}
                    onPointerDown={(event) => beginSelection(event, line)}
                    onPointerEnter={(event) => extendSelection(event, line)}
                  >
                    <span aria-hidden="true">+</span>
                    <span>{line.line}</span>
                  </button>
                  <span className="panel-static-code-marker" aria-hidden="true">
                    {line.marker ?? " "}
                  </span>
                  <code>{line.text || " "}</code>
                </span>
              </span>
            );
          })}
        </pre>
        {controller.threadInjection && injectionGeometry ? (
          <div className="panel-thread-overlay" style={injectionGeometry}>
            {controller.renderThreadInjection(controller.threadInjection)}
          </div>
        ) : null}
        <PanelThreadRail controller={controller} rows={rows} />
      </div>
      {controller.renderThreadArea()}
      {controller.renderThreadFooter()}
    </>
  );
}

function panelCodeLineHighlight(
  line: PanelCodeLine,
  controller: Pick<
    PanelThreadController,
    "dragRange" | "selectedRange" | "threadRanges"
  >,
): "idle" | "active" | "candidate" | undefined {
  if (panelRangeContainsLine(controller.dragRange, line)) return "candidate";
  if (panelRangeContainsLine(controller.selectedRange, line)) return "active";
  return controller.threadRanges.some((range) =>
    panelRangeContainsLine(range, line),
  )
    ? "idle"
    : undefined;
}

function panelRangeContainsLine(
  range: PanelLineRange | null,
  line: Pick<PanelCodeLine, "line" | "side">,
): boolean {
  return Boolean(
    range &&
    line.line >= range.fromLine &&
    line.line <= range.toLine &&
    (!range.side || !line.side || range.side === line.side),
  );
}

export function PanelAuthoredCodeSurface({
  anchor,
  code,
  language,
  selectionStamp,
}: {
  anchor: AnchorRef;
  code: string;
  language?: string;
  selectionStamp?: Record<string, string>;
}): ReactElement {
  const headRef = useResolvedHeadRef();
  const baseRef = useResolvedBaseRef();
  const source = anchor.peek?.resolution
    ? resolvedCodeSurface(anchor.peek.resolution)
    : null;
  const normalizedCode = normalizeLineEndings(code);
  const controller = usePanelThreadController({
    anchor,
    sourceText: normalizedCode,
    sourceFromLine: source?.fromLine ?? 1,
    sourceFile: source?.file,
    sourceCommit: headRef ?? undefined,
    threadHost: "content",
    createLineTarget:
      source && baseRef && headRef
        ? (range) =>
            buildAuthoredCodeLineTarget(
              {
                path: source.file,
                side: "head",
                baseCommit: baseRef,
                headCommit: headRef,
              },
              range,
            )
        : undefined,
  });
  const firstLine = source?.fromLine ?? 1;
  const lines = normalizedCode.split("\n").map((text, index) => ({
    key: `line:${firstLine + index}`,
    line: firstLine + index,
    text,
  }));
  return (
    <PanelCodeSurface
      lines={lines}
      controller={controller}
      className="panel-authored-code-surface panel-authored-code-block"
      language={language}
      selectionStamp={selectionStamp}
    />
  );
}

export function PanelThreadRail({
  controller,
  rows,
}: {
  controller: PanelThreadController;
  rows: readonly PanelMeasuredLine[];
}): ReactElement {
  return (
    <div className="panel-code-thread-rail" aria-label="Code comments">
      {controller.lineBadges.map((badge) => {
        const row = rows.find(
          (candidate) =>
            candidate.line === badge.line && candidate.side === badge.side,
        );
        if (!row) return null;
        const active = controller.isBadgeActive(badge.line, badge.side);
        return (
          <button
            type="button"
            key={`${badge.side ?? "file"}:${badge.line}`}
            className={
              active
                ? "panel-code-thread-badge panel-code-thread-badge--active"
                : "panel-code-thread-badge"
            }
            style={{ top: row.top + row.height / 2 }}
            aria-label={`Open ${badge.count} comments on line ${badge.line}`}
            onClick={() => controller.activateLine(badge.line, badge.side)}
          >
            {badge.count}
          </button>
        );
      })}
    </div>
  );
}
