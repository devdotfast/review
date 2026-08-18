import type {
  CSSProperties,
  ComponentPropsWithoutRef,
  ReactElement,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
} from "react";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  AnchorLinkProps,
  AnchorRef,
  ReviewSectionProps,
} from "../../src/authoring";
import {
  anchorLinkPropsSchema,
  reviewSectionPropsSchema,
} from "../../src/authoring";
import type { ThreadTarget } from "../../src/types";
import { AgentMarkdown } from "./agent-markdown";
import {
  CodePeekCard,
  type ValidatedCodePeekInput,
  validatedCodePeekInputFromRef,
} from "./CodePeek";
import { chipPositionClearOf } from "./document-selection";
import { useReviewSession } from "./host/review-session";
import { CloseIcon, CommentIcon, MapPinIcon, TerminalIcon } from "./icons";
import { newTabLinkProps } from "./link-props";
import { createClientId, useReview } from "./review-context";
import { useReviewPanel } from "./review-panel";
import {
  type ThreadPanel,
  selectActiveReviewPanel,
} from "./review-panel-store";
import { useReviewRoots } from "./review-root-context";
import {
  type ThreadView,
  commentThreadView,
  targetQuote,
  threadListStatus,
} from "./review-threads";
import { useReviewUiState } from "./review-ui-state";
import { useBottomSheetResize } from "./side-panel-resizer";
import {
  PanelAuthoredCodeSurface,
  panelEscapeAction,
  usePanelThreadController,
} from "./sidepeek-thread-ui";
import { buildAnchorTextTarget, targetKey } from "./target-fingerprint";
import { ThreadComposer } from "./thread-card";
import { useThreadTargetState } from "./thread-target-model";
import { captureUiEvent } from "./ui-telemetry";

const TOUR_ACTIVE_TOP_SLACK_PX = 18;

/**
 * Shared shell for everything that docks into the right panel slot: side
 * peeks, guided tours, and the threads panel. Provides the uniform header
 * (kicker, title, count, close button), closes on Escape, and slides in with
 * the same animation everywhere. The panel occupies a grid column, so the
 * document reflows next to it instead of being overlaid.
 */
function ReviewPanelFrame({
  label,
  title,
  count,
  onClose,
  closeLabel,
  headerStart,
  titleAccessory,
  afterHeader,
  titleSelectionStamp,
  onMouseUp,
  selectionAction,
  floatingFooter,
  bodyRef,
  onBodyScroll,
  className,
  children,
}: {
  label: string;
  title?: string;
  count?: number;
  onClose: () => void;
  closeLabel: string;
  headerStart?: ReactNode;
  titleAccessory?: ReactNode;
  afterHeader?: ReactNode;
  titleSelectionStamp?: PanelSelectionStamp;
  onMouseUp?: (event: ReactMouseEvent<HTMLElement>) => void;
  selectionAction?: ReactNode;
  floatingFooter?: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  onBodyScroll?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const appRef = useReviewRoots()?.appRef;
  const panelMotion = useReviewPanel((state) => state.motion);
  const sheet = useBottomSheetResize({
    stateKey: "bottomSheetFraction",
    label: "Resize panel height",
    containerRef: appRef,
  });
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const app = appRef?.current;
      if (!app) return;
      // A comment draft popover stacked above the panel wins the Escape.
      if (app.querySelector(".thread-popover")) return;
      const panelDraftOpen =
        app.querySelector(".side-panel .thread-card--draft") !== null;
      const action = panelEscapeAction({
        menuOpen:
          app.querySelector('.side-panel .thread-card [role="menu"]') !== null,
        draftHasText: panelDraftOpen ? false : null,
        threadExpanded:
          app.querySelector(".side-panel .panel-thread-active-card") !== null,
      });
      if (action !== "close-panel") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [appRef, onClose]);

  return (
    <aside
      className={[
        "side-panel",
        className,
        panelMotion === "restored" ? "side-panel--restored" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      role="complementary"
      aria-label={title ?? label}
      onMouseUp={onMouseUp}
      style={
        { "--side-panel-bottom-fraction": sheet.fraction } as CSSProperties
      }
    >
      <div className="side-panel-sheet-resizer" {...sheet.separatorProps} />
      <header className="side-panel-header">
        <div className="side-panel-title">
          {headerStart}
          <span className="side-panel-kicker">{label}</span>
          {title && (
            <h2 {...panelSelectionStamp(titleSelectionStamp)}>{title}</h2>
          )}
          {typeof count === "number" && count > 0 && <em>{count}</em>}
          {titleAccessory}
        </div>
        <button
          type="button"
          className="icon-button side-panel-close"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <CloseIcon />
        </button>
      </header>
      <div
        ref={bodyRef}
        className="review-panel-body"
        data-review-scroll-owner="panel"
        onScroll={onBodyScroll}
      >
        {afterHeader}
        {children}
      </div>
      {floatingFooter}
      {selectionAction}
    </aside>
  );
}

interface ReviewSectionSummary {
  diagrams: number;
  codeRefs: number;
  paragraphs: number;
}

/**
 * Collapsible document section produced by the remark-review-sections plugin:
 * the first child is normally the section's H2 heading, the rest is the
 * section body. Older or manually authored modules may omit that heading; in
 * that case the title supplies it and every authored child remains in the body.
 * Collapse state persists per document+section in localStorage; sections
 * marked `[collapsed]` in the MDX start collapsed for first-time readers.
 */
export function ReviewSection(props: ReviewSectionProps) {
  const {
    title,
    defaultCollapsed = false,
    children,
  } = reviewSectionPropsSchema.parse(props);
  const [collapsed, setCollapsed] = useReviewUiState(title, defaultCollapsed, {
    scope: "session",
    namespace: "section",
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [summary, setSummary] = useState<ReviewSectionSummary | null>(null);
  const { heading, body } = reviewSectionContent(title, children);

  const toggleCollapsed = () => setCollapsed((current) => !current);

  useLayoutEffect(() => {
    const bodyElement = bodyRef.current;
    if (!bodyElement) return;
    setSummary({
      diagrams: bodyElement.querySelectorAll(
        ".sequence-diagram, .database-lens, .software-map",
      ).length,
      codeRefs: bodyElement.querySelectorAll(
        "a[data-review-anchor-id], .code-peek",
      ).length,
      paragraphs: bodyElement.querySelectorAll("p").length,
    });
  }, [children]);

  // The table of contents (and anchor navigation) expands a collapsed
  // section before scrolling to a heading inside it.
  useEffect(() => {
    const bodyElement = bodyRef.current;
    const sectionElement = bodyElement?.parentElement;
    if (!sectionElement) return;
    const expand = () => setCollapsed(false);
    sectionElement.addEventListener("review-section-expand", expand);
    return () => {
      sectionElement.removeEventListener("review-section-expand", expand);
    };
  }, []);

  return (
    <section
      className={
        collapsed
          ? "review-section review-section--collapsed"
          : "review-section"
      }
      data-review-section={title}
    >
      <div className="review-section-header">
        <button
          type="button"
          className="review-section-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          onClick={toggleCollapsed}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.5 2 L9 6 L3.5 10 Z" />
          </svg>
        </button>
        <div className="review-section-heading">{heading}</div>
        {collapsed && summary && (
          <span className="review-section-meta">
            {reviewSectionSummaryLabel(summary)}
          </span>
        )}
      </div>
      <div
        ref={bodyRef}
        className="review-section-body"
        hidden={collapsed || undefined}
      >
        {body}
      </div>
    </section>
  );
}

function reviewSectionContent(
  title: string,
  children: ReactNode,
): { heading: ReactElement; body: ReactNode[] } {
  const childNodes = Children.toArray(children);
  const [firstChild, ...remainingChildren] = childNodes;
  if (isReviewSectionHeading(firstChild)) {
    return { heading: firstChild, body: remainingChildren };
  }
  return { heading: <h2>{title}</h2>, body: childNodes };
}

function isReviewSectionHeading(child: ReactNode): child is ReactElement {
  if (!isValidElement(child)) return false;
  if (child.type === "h2") return true;
  return (
    (child.props as Record<string, unknown>)["data-review-block-tag"] === "h2"
  );
}

function reviewSectionSummaryLabel(summary: ReviewSectionSummary): string {
  const parts: string[] = [];
  if (summary.diagrams > 0) {
    parts.push(
      summary.diagrams === 1 ? "1 diagram" : `${summary.diagrams} diagrams`,
    );
  }
  if (summary.codeRefs > 0) {
    parts.push(
      summary.codeRefs === 1 ? "1 code ref" : `${summary.codeRefs} code refs`,
    );
  }
  if (parts.length === 0 && summary.paragraphs > 0) {
    parts.push(
      summary.paragraphs === 1
        ? "1 paragraph"
        : `${summary.paragraphs} paragraphs`,
    );
  }
  return parts.join(" · ");
}

export function AnchorLink(props: AnchorLinkProps) {
  const session = useReviewSession();
  const { anchor, children } = anchorLinkPropsSchema.parse(props);
  const input = validatedCodePeekInputFromRef(anchor.peek);
  const openPeek = useReviewPanel((state) => state.openPeek);
  const peekOpen = useReviewPanel((state) => {
    const active = selectActiveReviewPanel(state);
    return active?.kind === "peek" && active.anchor.id === anchor.id;
  });
  const target = buildAnchorTextTarget({
    anchorId: anchor.id,
    field: "title",
    text: anchor.title,
  });
  return (
    <a
      href={`#review-anchor-${anchor.id}`}
      data-review-anchor-id={anchor.id}
      data-review-anchor-open={peekOpen ? "true" : undefined}
      data-review-locator={targetKey(target)}
      onClick={(event) => {
        event.preventDefault();
        captureUiEvent(session, "peek_opened", { via: "prose_link" });
        openPeek(anchor, { kind: "resolved-code", input });
        keepAnchorLinkVisible(event.currentTarget);
      }}
    >
      {children}
    </a>
  );
}

export function a({
  href,
  children,
  target,
  rel,
  ...props
}: ComponentPropsWithoutRef<"a">) {
  const linkProps = newTabLinkProps(href, { ...props, target, rel });
  return (
    <a href={href} target={target} rel={rel} {...props} {...linkProps}>
      {children}
    </a>
  );
}

/**
 * Opening the side panel narrows the document column and reflows the prose,
 * which can push the clicked anchor link out of the viewport. Once the panel
 * has slid in, scroll the link back into view if the reflow moved it away.
 */
function keepAnchorLinkVisible(link: HTMLElement) {
  window.setTimeout(() => {
    const rect = link.getBoundingClientRect();
    const visible =
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth;
    if (!visible) {
      link.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, 240);
}

type PanelSelectionField = "title" | "detail" | "code";

interface PanelSelectionStamp {
  anchorId: string;
  field: PanelSelectionField;
}

interface PanelSelectionSource {
  anchor: AnchorRef;
  field: PanelSelectionField;
  text: string;
}

interface PanelSelectionTarget {
  x: number;
  y: number;
  target: ThreadTarget;
  quote: string;
}

function panelSelectionStamp(
  stamp?: PanelSelectionStamp,
): Record<string, string> {
  return stamp
    ? {
        "data-panel-selection-anchor": stamp.anchorId,
        "data-panel-selection-field": stamp.field,
      }
    : {};
}

function panelSelectionSources(
  sources: PanelSelectionSource[],
): ReadonlyMap<string, PanelSelectionSource> {
  return new Map(
    sources.map((source) => [`${source.anchor.id}:${source.field}`, source]),
  );
}

function handlePanelSelectionMouseUp(
  event: ReactMouseEvent<HTMLElement>,
  sources: ReadonlyMap<string, PanelSelectionSource>,
  setTarget: (target: PanelSelectionTarget | null) => void,
): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    setTarget(null);
    return;
  }
  const range = selection.getRangeAt(0);
  const startSurface = panelSelectionSurface(
    range.startContainer,
    event.currentTarget,
  );
  const endSurface = panelSelectionSurface(
    range.endContainer,
    event.currentTarget,
  );
  if (!startSurface || startSurface !== endSurface) {
    setTarget(null);
    return;
  }
  const anchorId = startSurface.dataset.panelSelectionAnchor;
  const field = startSurface.dataset.panelSelectionField as
    | PanelSelectionField
    | undefined;
  if (!anchorId || !field) {
    setTarget(null);
    return;
  }
  if (field === "code") {
    setTarget(null);
    return;
  }
  const source = sources.get(`${anchorId}:${field}`);
  if (!source) {
    setTarget(null);
    return;
  }
  const selectedText = selection.toString();
  if (!selectedText) {
    setTarget(null);
    return;
  }
  const prefix = document.createRange();
  prefix.selectNodeContents(startSurface);
  prefix.setEnd(range.startContainer, range.startOffset);
  const mappedStart = prefix.toString().length;
  const start = source.text.indexOf(selectedText, Math.max(0, mappedStart - 1));
  if (start < 0) {
    throw new Error(
      "Unable to map the panel selection into its stamped surface.",
    );
  }
  const target = buildAnchorTextTarget({
    anchorId,
    field,
    text: source.text,
    start,
    length: selectedText.length,
  });
  const rect = range.getBoundingClientRect();
  /* The chip stays fixed, so it is placed in the coordinate space of
     `.review-canvas-root` — that box sets `contain: layout` and is therefore
     the containing block for fixed descendants. Raw viewport coords land the
     chip on the highlight. */
  const root = event.currentTarget.closest<HTMLElement>(".review-canvas-root");
  const rootRect = root?.getBoundingClientRect() ?? {
    left: 0,
    top: 0,
    width: event.currentTarget.ownerDocument.documentElement.clientWidth,
  };
  setTarget({
    ...chipPositionClearOf(rect, rootRect),
    target,
    quote: selectedText,
  });
}

function panelSelectionSurface(
  node: Node,
  panel: HTMLElement,
): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const surface = element?.closest<HTMLElement>(
    "[data-panel-selection-anchor][data-panel-selection-field]",
  );
  return surface && panel.contains(surface) ? surface : null;
}

function PanelSelectionCommentButton({
  target,
  clearTarget,
}: {
  target: PanelSelectionTarget | null;
  clearTarget: () => void;
}): ReactNode {
  const review = useReview();
  if (!target) return null;
  return (
    <div
      className="selection-action-buttons panel-selection-action"
      style={{ left: target.x, top: target.y }}
    >
      <button
        type="button"
        className="selection-action-segment selection-comment-button"
        aria-label={
          review.pendingCommentCount > 0
            ? "Comment on selection"
            : "Ask about selection"
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          review.openCommentDraft({
            target: target.target,
            title:
              target.quote.length > 72
                ? `${target.quote.slice(0, 69).trimEnd()}...`
                : target.quote,
            body: "",
            draftSurface: "panel",
          });
          clearTarget();
        }}
      >
        <CommentIcon />
        <span>{review.pendingCommentCount > 0 ? "Comment" : "Ask"}</span>
      </button>
    </div>
  );
}

export type ReviewPeekContent =
  | { kind: "resolved-code"; input: ValidatedCodePeekInput }
  | { kind: "inline-code"; language?: string; text: string };

export interface GuidedTourStop {
  anchor: AnchorRef;
  label: string;
  detail?: string;
  content: ReviewPeekContent;
}

export interface GuidedTour {
  id: string;
  title?: string;
  stops: GuidedTourStop[];
  telemetryKind?: "sequence";
}

/** The only top-level renderer for Review's detail and thread panel modes. */
export function ReviewPanelHost() {
  const activePanel = useReviewPanel(selectActiveReviewPanel);
  const closeActive = useReviewPanel((state) => state.closeActive);
  const activateTourAnchor = useReviewPanel(
    (state) => state.activateTourAnchor,
  );
  if (!activePanel) return null;

  return (
    <>
      {activePanel.kind === "peek" ? (
        <ReviewPeekPanel
          anchor={activePanel.anchor}
          content={activePanel.content}
          onClose={closeActive}
        />
      ) : activePanel.kind === "commit-diff" ? (
        <CommitFileDiffPanel
          commit={activePanel.commit}
          file={activePanel.file}
          onClose={closeActive}
        />
      ) : activePanel.kind === "tour" ? (
        <GuidedTourPanel
          tour={activePanel.tour}
          activeAnchor={activePanel.activeAnchor}
          revealRequest={activePanel.revealRequest}
          onActiveAnchorChange={activateTourAnchor}
          onClose={closeActive}
        />
      ) : (
        <ThreadPanelInner panel={activePanel} onClose={closeActive} />
      )}
    </>
  );
}

function CommitFileDiffPanel({
  commit,
  file,
  onClose,
}: {
  commit: import("@dev.fast/review-protocol").ReviewCommitSummary;
  file: import("@dev.fast/review-protocol").ReviewDiffFileWire;
  onClose: () => void;
}) {
  return (
    <ReviewPanelFrame
      className="side-peek commit-file-diff-panel"
      label={`Commit ${commit.commit.slice(0, 8)}`}
      title={file.path}
      onClose={onClose}
      closeLabel="Close commit diff"
    >
      <div className="commit-file-diff-body">
        {file.patch ? (
          <pre aria-label={`Diff for ${file.path}`}>{file.patch}</pre>
        ) : (
          <p>This file has no text patch.</p>
        )}
      </div>
    </ReviewPanelFrame>
  );
}

export function ReviewPeekPanel({
  anchor,
  content,
  onClose,
}: {
  anchor: AnchorRef;
  content: ReviewPeekContent;
  onClose: () => void;
}) {
  const review = useReview();
  const titleThreadController = usePanelThreadController({
    anchor,
    threadHost: "title",
  });
  const [selectionTarget, setSelectionTarget] =
    useState<PanelSelectionTarget | null>(null);
  const selectionSources = panelSelectionSources([
    { anchor, field: "title", text: anchor.title },
    ...(content.kind === "inline-code"
      ? [{ anchor, field: "code" as const, text: content.text }]
      : []),
  ]);
  return (
    <ReviewPanelFrame
      className="side-peek"
      label="Peek"
      title={anchor.title}
      titleSelectionStamp={{ anchorId: anchor.id, field: "title" }}
      titleAccessory={titleThreadController.renderTitleMarker()}
      afterHeader={
        <div className="panel-title-thread-host">
          {titleThreadController.renderThreadArea()}
          {titleThreadController.renderThreadFooter()}
        </div>
      }
      onClose={onClose}
      closeLabel="Close side peek"
      onMouseUp={(event) =>
        handlePanelSelectionMouseUp(event, selectionSources, setSelectionTarget)
      }
      selectionAction={
        <PanelSelectionCommentButton
          target={selectionTarget}
          clearTarget={() => setSelectionTarget(null)}
        />
      }
    >
      <div className="side-peek-body">
        <div className="peek-actions">
          {review.softwareMapEnabled && anchor.softwareMapPath ? (
            <button
              type="button"
              onClick={() => {
                review.openSoftwareMapElement(anchor.softwareMapPath!);
                onClose();
              }}
              className="icon-button icon-button--map"
              aria-label={`Show ${anchor.title} in software map`}
            >
              <MapPinIcon />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              review.openCommentDraft({
                ...review.createAnchorCommentTarget(anchor),
                draftSurface: "panel",
              })
            }
            className="icon-button icon-button--comment"
            aria-label="Comment on side peek"
          >
            <CommentIcon />
          </button>
        </div>

        <div className="peek-content">
          <ReviewPeekContentView anchor={anchor} content={content} />
        </div>
      </div>
    </ReviewPanelFrame>
  );
}

export function GuidedTourPanel({
  tour,
  activeAnchor,
  revealRequest,
  onActiveAnchorChange,
  onClose,
}: {
  tour: GuidedTour;
  activeAnchor: string;
  revealRequest: number;
  onActiveAnchorChange: (anchor: string, options: { reveal: boolean }) => void;
  onClose: () => void;
}) {
  const session = useReviewSession();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const handledRevealRequestRef = useRef(0);
  const activeIndex = tour.stops.findIndex(
    (stop) => stop.anchor.id === activeAnchor,
  );
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const previousActiveIndexRef = useRef(activeIndex);
  const completedTourIdRef = useRef<string | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const [tailHeight, setTailHeight] = useState(0);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [selectionTarget, setSelectionTarget] =
    useState<PanelSelectionTarget | null>(null);
  const selectionSources = panelSelectionSources(
    tour.stops.flatMap((stop) => [
      ...(stop.label === stop.anchor.title
        ? [
            {
              anchor: stop.anchor,
              field: "title" as const,
              text: stop.anchor.title,
            },
          ]
        : []),
      ...(stop.detail && stop.detail === stop.anchor.detail
        ? [
            {
              anchor: stop.anchor,
              field: "detail" as const,
              text: stop.anchor.detail,
            },
          ]
        : []),
      ...(stop.content.kind === "inline-code"
        ? [
            {
              anchor: stop.anchor,
              field: "code" as const,
              text: stop.content.text,
            },
          ]
        : []),
    ]),
  );

  useEffect(() => {
    completedTourIdRef.current = null;
    previousActiveIndexRef.current = activeIndexRef.current;
    setHasScrolled(false);
  }, [tour.id]);

  useEffect(() => {
    const previousIndex = previousActiveIndexRef.current;
    previousActiveIndexRef.current = activeIndex;
    if (activeIndex <= previousIndex || activeIndex < 0) return;
    captureUiEvent(session, "tour_step_advanced", {
      step: activeIndex + 1,
      steps: tour.stops.length,
    });
  }, [activeIndex, session, tour.stops.length]);

  useEffect(() => {
    let armed = false;
    const timer = window.setTimeout(() => {
      armed = true;
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const index = activeIndexRef.current;
      if (
        !armed ||
        tour.stops.length === 0 ||
        index >= tour.stops.length - 1 ||
        completedTourIdRef.current === tour.id
      ) {
        return;
      }
      captureUiEvent(session, "tour_abandoned", {
        step: Math.max(0, index) + 1,
        steps: tour.stops.length,
      });
    };
  }, [session, tour.id, tour.stops.length]);

  // Scroll-syncing activates a stop when its top crosses the active line, so
  // the last stop must be able to reach it: the tail spacer grants exactly
  // the missing scroll room. Sized here because a CSS percentage cannot see
  // the scroller's height from inside auto-height feed content.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const lastStop = tour.stops[tour.stops.length - 1];
    if (!lastStop) return;
    const measure = () => {
      const section = sectionRefs.current.get(lastStop.anchor.id);
      const tail = tailRef.current;
      if (!section || !tail) return;
      const lastTopInContent =
        section.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const contentSansTail = scroller.scrollHeight - tail.offsetHeight;
      setTailHeight(
        Math.max(
          0,
          Math.ceil(
            lastTopInContent -
              TOUR_ACTIVE_TOP_SLACK_PX +
              scroller.clientHeight -
              contentSansTail,
          ),
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [tour]);

  useEffect(() => {
    if (
      tour.stops.length === 0 ||
      activeIndex < tour.stops.length - 1 ||
      completedTourIdRef.current === tour.id
    ) {
      return;
    }
    completedTourIdRef.current = tour.id;
    captureUiEvent(session, "tour_completed", { steps: tour.stops.length });
  }, [activeIndex, session, tour]);

  useEffect(() => {
    if (handledRevealRequestRef.current === revealRequest) return;
    handledRevealRequestRef.current = revealRequest;
    const scroller = scrollerRef.current;
    const section = sectionRefs.current.get(activeAnchor);
    if (!section || !scroller) return;
    const frame = requestAnimationFrame(() => {
      const scrollerTop = scroller.getBoundingClientRect().top;
      const sectionTop = section.getBoundingClientRect().top;
      scroller.scrollTo({
        top: scroller.scrollTop + sectionTop - scrollerTop,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeAnchor, revealRequest]);

  const displayIndex = Math.max(0, activeIndex);
  const lastIndex = tour.stops.length - 1;
  const stepTo = (index: number) => {
    const stop = tour.stops[index];
    if (!stop) return;
    onActiveAnchorChange(stop.anchor.id, { reveal: true });
  };
  const showIntroPill =
    !hasScrolled && displayIndex === 0 && tour.stops.length > 1;
  // Docusaurus's TOC rule: the first stop whose top is still below the
  // scroller's top edge is the candidate. Once it reaches the top half of
  // the viewport it takes the highlight; until then the previous stop keeps
  // it. Past every stop, the last one holds. The look-ahead protects the
  // top edge structurally — at scroll zero the candidate is stop one, no
  // matter how short it is.
  const syncActiveStopToScroll = () => {
    setHasScrolled(true);
    const scroller = scrollerRef.current;
    const lastStop = tour.stops[tour.stops.length - 1];
    if (!scroller || !lastStop) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const halfLine = scrollerRect.top + scrollerRect.height / 2;
    let nextAnchor = lastStop.anchor.id;
    for (let index = 0; index < tour.stops.length; index += 1) {
      const stop = tour.stops[index]!;
      const section = sectionRefs.current.get(stop.anchor.id);
      if (!section) continue;
      const top = section.getBoundingClientRect().top;
      if (top < scrollerRect.top) continue;
      nextAnchor =
        top <= halfLine
          ? stop.anchor.id
          : (tour.stops[index - 1] ?? stop).anchor.id;
      break;
    }
    if (nextAnchor === activeAnchor) return;
    onActiveAnchorChange(nextAnchor, { reveal: false });
  };

  return (
    <ReviewPanelFrame
      className="side-peek side-peek--tour"
      label="Tour"
      title={tour.title ?? "Guided tour"}
      onClose={onClose}
      closeLabel="Close guided tour"
      onMouseUp={(event) =>
        handlePanelSelectionMouseUp(event, selectionSources, setSelectionTarget)
      }
      selectionAction={
        <PanelSelectionCommentButton
          target={selectionTarget}
          clearTarget={() => setSelectionTarget(null)}
        />
      }
      floatingFooter={
        tour.stops.length > 0 ? (
          <div className="tour-floating-footer">
            {showIntroPill ? (
              <button
                type="button"
                className="tour-pill tour-pill--intro"
                onClick={() => {
                  setHasScrolled(true);
                  stepTo(1);
                }}
              >
                <span>{tour.stops.length - 1} more steps</span>
                <span className="tour-pill-chevron" aria-hidden="true">
                  ↓
                </span>
              </button>
            ) : (
              <div className="tour-pill" role="group" aria-label="Tour steps">
                <button
                  type="button"
                  aria-label="Previous step"
                  disabled={displayIndex === 0}
                  onClick={() => stepTo(displayIndex - 1)}
                >
                  ↑
                </button>
                <span className="tour-pill-count" aria-live="polite">
                  {displayIndex + 1}/{tour.stops.length}
                </span>
                <button
                  type="button"
                  aria-label="Next step"
                  disabled={displayIndex === lastIndex}
                  onClick={() => stepTo(displayIndex + 1)}
                >
                  ↓
                </button>
              </div>
            )}
          </div>
        ) : null
      }
      bodyRef={scrollerRef}
      onBodyScroll={syncActiveStopToScroll}
    >
      <div className="tour-feed-shell">
        <div className="side-peek-body tour-feed">
          {tour.stops.map((stop, index) => {
            const isActive = stop.anchor.id === activeAnchor;
            return (
              <section
                key={stop.anchor.id}
                ref={(node) => {
                  if (node) sectionRefs.current.set(stop.anchor.id, node);
                  else sectionRefs.current.delete(stop.anchor.id);
                }}
                className={isActive ? "tour-stop active" : "tour-stop"}
                data-review-anchor-id={stop.anchor.id}
              >
                <div className="tour-stop-rail">
                  <div>{index + 1}</div>
                </div>
                <GuidedTourStopMain
                  stop={stop}
                  index={index}
                  total={tour.stops.length}
                  active={isActive}
                  onNativeFocus={() => {
                    if (stop.anchor.id === activeAnchor) return;
                    onActiveAnchorChange(stop.anchor.id, { reveal: false });
                  }}
                  onClose={onClose}
                />
              </section>
            );
          })}
          {tour.stops.length > 0 && (
            <>
              <div className="tour-end-cap">
                <span>End of tour</span>
                <button type="button" onClick={() => stepTo(0)}>
                  ↑ Back to step 1
                </button>
              </div>
              <div
                ref={tailRef}
                className="tour-scroll-tail"
                style={{ height: tailHeight }}
                aria-hidden="true"
              />
            </>
          )}
        </div>
      </div>
    </ReviewPanelFrame>
  );
}

function GuidedTourStopMain({
  stop,
  index,
  total,
  active,
  onNativeFocus,
  onClose,
}: {
  stop: GuidedTourStop;
  index: number;
  total: number;
  active: boolean;
  onNativeFocus: () => void;
  onClose: () => void;
}): ReactElement {
  const review = useReview();
  const titleThreadController = usePanelThreadController({
    anchor: stop.anchor,
    threadHost: "title",
  });
  return (
    <div className="tour-stop-main">
      <header className="tour-stop-header">
        <div>
          <div className="tour-stop-count">
            Step {index + 1} of {total}
          </div>
          <div className="tour-stop-title-row">
            <h3
              {...panelSelectionStamp(
                stop.label === stop.anchor.title
                  ? { anchorId: stop.anchor.id, field: "title" }
                  : undefined,
              )}
            >
              {stop.label}
            </h3>
            {titleThreadController.renderTitleMarker()}
          </div>
          <div className="panel-title-thread-host">
            {titleThreadController.renderThreadArea()}
            {titleThreadController.renderThreadFooter()}
          </div>
          {stop.detail && (
            <p
              {...panelSelectionStamp(
                stop.detail === stop.anchor.detail
                  ? { anchorId: stop.anchor.id, field: "detail" }
                  : undefined,
              )}
            >
              {stop.detail}
            </p>
          )}
        </div>
        <div className="peek-actions">
          <button
            type="button"
            className="icon-button icon-button--comment"
            aria-label={`Comment on ${stop.label}`}
            onClick={() =>
              review.openCommentDraft({
                ...review.createAnchorCommentTarget(stop.anchor),
                draftSurface: "panel",
              })
            }
          >
            <CommentIcon />
          </button>
          {review.softwareMapEnabled && stop.anchor.softwareMapPath ? (
            <button
              type="button"
              className="icon-button icon-button--map"
              aria-label={`Show ${stop.anchor.title} in software map`}
              onClick={() => {
                review.openSoftwareMapElement(stop.anchor.softwareMapPath!);
                onClose();
              }}
            >
              <MapPinIcon />
            </button>
          ) : null}
        </div>
      </header>

      <div className="peek-content">
        <ReviewPeekContentView
          anchor={stop.anchor}
          content={stop.content}
          active={active}
          onNativeFocus={onNativeFocus}
        />
      </div>
    </div>
  );
}

export function ReviewPeekContentView({
  anchor,
  content,
  active,
  onNativeFocus,
}: {
  anchor: AnchorRef;
  content: ReviewPeekContent;
  active?: boolean;
  onNativeFocus?: () => void;
}) {
  return content.kind === "resolved-code" ? (
    <CodePeekCard
      input={content.input}
      active={active}
      heightMode="content"
      onNativeFocus={onNativeFocus}
      commentAnchor={anchor}
    />
  ) : (
    <PanelAuthoredCodeSurface
      anchor={anchor}
      code={content.text}
      language={content.language}
      selectionStamp={panelSelectionStamp({
        anchorId: anchor.id,
        field: "code",
      })}
    />
  );
}

/**
 * The side panel shows one comment thread, a new document-level thread, or
 * the list of all review threads.
 */
function ThreadPanelInner({
  panel,
  onClose,
}: {
  panel: ThreadPanel;
  onClose: () => void;
}) {
  const review = useReview();
  const session = useReviewSession();
  const openCommentThread = useReviewPanel((state) => state.openCommentThread);
  const showThreads = useReviewPanel((state) => state.showThreads);
  const openNewAsk = useReviewPanel((state) => state.openNewAsk);
  const newAskTargetRef = useRef<{
    threadId: string;
    target: ThreadTarget;
    title: string;
  }>({
    threadId: createClientId(),
    target: { kind: "document" },
    title: "Entire document",
  });
  const commentThreadId =
    panel.kind === "commentThread" ? panel.threadId : null;
  const target = panel.kind === "new-ask" ? newAskTargetRef.current : null;
  const commentThread = commentThreadId
    ? ([...review.allCommentThreads(), ...review.resolvedCommentThreads()].find(
        (candidate) => candidate.threadId === commentThreadId,
      ) ?? null)
    : null;
  const thread = commentThread ? commentThreadView(commentThread) : null;
  const listThreads = review
    .allCommentThreads()
    .map(commentThreadView)
    .sort(
      (left, right) =>
        (Date.parse(right.latestAt) || 0) - (Date.parse(left.latestAt) || 0),
    );
  const resolvedThreads = review
    .resolvedCommentThreads()
    .map(commentThreadView)
    .sort(
      (left, right) =>
        (Date.parse(right.latestAt) || 0) - (Date.parse(left.latestAt) || 0),
    );

  const askNow = async (body: string) => {
    const destination = commentThread ?? target;
    if (!destination) return;
    await review.askAgent({
      threadId: destination.threadId,
      messageId: createClientId(),
      target: destination.target,
      body,
    });
    if (panel.kind === "new-ask") openCommentThread(destination.threadId);
  };
  const resumeInTerminal = async (item: ThreadView) => {
    const response = await session.fetch(
      `/comments/${encodeURIComponent(item.threadId)}/agent-terminal`,
      { method: "POST" },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(result?.error ?? "Unable to resume the agent terminal.");
    }
  };
  const addToReview = async (body: string) => {
    const destination = commentThread ?? target;
    if (!destination) return;
    await review.saveComment({
      threadId: destination.threadId,
      messageId: createClientId(),
      target: destination.target,
      body,
    });
    if (panel.kind === "new-ask") {
      showThreads();
    } else {
      openCommentThread(destination.threadId);
    }
  };
  const selectListThread = (item: ThreadView) => {
    // Scroll to and highlight the anchor, but keep the detail here in the
    // sidebar (highlight-only focus, no inline surface).
    review.focusThread(item.threadId, { scroll: true, inline: false });
    openCommentThread(item.threadId);
  };

  return (
    <ReviewPanelFrame
      className="question-panel"
      label={panel.kind === "threads" ? "Threads" : ""}
      count={panel.kind === "threads" ? listThreads.length : undefined}
      onClose={onClose}
      closeLabel="Close threads"
      headerStart={
        panel.kind !== "threads" ? (
          <button
            type="button"
            className="thread-chat-back"
            aria-label="Show all threads"
            onClick={showThreads}
          >
            <svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true">
              <path d="M5 1 1 5l4 4M1 5h10" />
            </svg>
            <span>Threads</span>
            <em>{listThreads.length}</em>
          </button>
        ) : undefined
      }
      titleAccessory={
        panel.kind === "threads" ? (
          !review.historicalRevision ? (
            <button
              type="button"
              className="threads-new-ask"
              onClick={() => {
                captureUiEvent(session, "new_ask_opened", {
                  via: "threads_panel",
                });
                openNewAsk();
              }}
            >
              + New ask
            </button>
          ) : undefined
        ) : thread?.agentSession && !review.historicalRevision ? (
          <button
            type="button"
            className="thread-resume-terminal"
            aria-label="Resume in terminal"
            title="Resume in terminal"
            onClick={() => void resumeInTerminal(thread)}
          >
            <TerminalIcon />
          </button>
        ) : undefined
      }
    >
      {panel.kind !== "threads" ? (
        <ThreadChat
          thread={thread}
          quote={
            thread?.quote ??
            target?.title ??
            (target ? targetQuote(target.target) : "Entire document")
          }
          newAsk={panel.kind === "new-ask"}
          readOnly={Boolean(review.historicalRevision)}
          onAskNow={askNow}
          onAddToReview={addToReview}
        />
      ) : (
        <>
          <ThreadPanelList
            threads={listThreads}
            activeLocator={review.focusedThreadId}
            onSelect={selectListThread}
            onResumeInTerminal={resumeInTerminal}
            readOnly={Boolean(review.historicalRevision)}
          />
          {resolvedThreads.length > 0 && (
            <details className="thread-resolved-section">
              <summary>
                Resolved
                <span>{resolvedThreads.length}</span>
              </summary>
              <ThreadPanelList
                threads={resolvedThreads}
                activeLocator={review.focusedThreadId}
                onSelect={selectListThread}
                onResumeInTerminal={resumeInTerminal}
                readOnly={Boolean(review.historicalRevision)}
              />
            </details>
          )}
        </>
      )}
    </ReviewPanelFrame>
  );
}

function ThreadChat({
  thread,
  quote,
  newAsk,
  readOnly,
  onAskNow,
  onAddToReview,
}: {
  thread: ThreadView | null;
  quote: string;
  newAsk: boolean;
  readOnly: boolean;
  onAskNow: (body: string) => Promise<void>;
  onAddToReview: (body: string) => Promise<void>;
}) {
  return (
    <div className="thread-chat">
      <div className="thread-chat-context">
        <i aria-hidden="true" />
        <span>{quote}</span>
      </div>
      <div className="thread-chat-transcript">
        {thread?.messages.map((message) => (
          <div
            key={message.id}
            className={
              message.userAuthored
                ? "thread-chat-message thread-chat-message--you"
                : "thread-chat-message thread-chat-message--agent"
            }
          >
            <span className="thread-chat-speaker">
              {message.userAuthored ? "you" : "agent"}
            </span>
            {message.agentMarkdown ? (
              <AgentMarkdown
                source={message.body}
                className="thread-chat-message-body"
              />
            ) : (
              <div className="thread-chat-message-body">{message.body}</div>
            )}
          </div>
        ))}
      </div>
      {!readOnly && !thread?.resolved && (
        <div className="thread-chat-composer">
          <ThreadComposer
            kind="new-thread"
            placeholder={
              newAsk ? "Ask or add to review..." : "Reply or add to review..."
            }
            autoFocus={newAsk}
            onAskNow={onAskNow}
            onAddToReview={onAddToReview}
          />
        </div>
      )}
    </div>
  );
}

function ThreadPanelList({
  threads,
  activeLocator,
  onSelect,
  onResumeInTerminal,
  readOnly,
}: {
  threads: ThreadView[];
  activeLocator: string | null;
  onSelect: (thread: ThreadView) => void;
  onResumeInTerminal: (thread: ThreadView) => Promise<void>;
  readOnly: boolean;
}) {
  if (threads.length === 0) {
    return (
      <div className="question-sidebar-list question-sidebar-list--empty">
        <CommentIcon />
        <strong>No threads yet</strong>
        <p>Comment on or ask about highlighted review text.</p>
      </div>
    );
  }
  return (
    <div className="question-sidebar-list">
      {threads.map((thread) => (
        <ThreadPanelListRow
          key={thread.key}
          thread={thread}
          active={thread.threadId === activeLocator}
          onSelect={onSelect}
          onResumeInTerminal={onResumeInTerminal}
          readOnly={readOnly}
        />
      ))}
    </div>
  );
}

function ThreadPanelListRow({
  thread,
  active,
  onSelect,
  onResumeInTerminal,
  readOnly,
}: {
  thread: ThreadView;
  active: boolean;
  onSelect: (thread: ThreadView) => void;
  onResumeInTerminal: (thread: ThreadView) => Promise<void>;
  readOnly: boolean;
}) {
  const targetState = useThreadTargetState(thread.target);
  const status = threadListStatus(thread);
  return (
    <div
      className={[
        "question-thread-row",
        active ? "question-thread-row--active" : "",
        thread.resolved ? "question-thread-row--resolved" : "",
        "question-thread-row--comment",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="question-thread-row-select"
        onClick={() => onSelect(thread)}
      >
        <span className="question-thread-row-quote">
          <i aria-hidden="true" />
          <strong>{thread.quote}</strong>
        </span>
        <span className="question-thread-row-preview">
          {thread.messages.at(-1)?.body}
        </span>
        <span className="question-thread-row-status">
          <strong className={`question-thread-status--${status}`}>
            {status}
          </strong>
          <span>
            {status === "pending"
              ? "sends with finish review"
              : targetState.state === "outdated"
                ? "outdated"
                : thread.messages.length === 1
                  ? "1 message"
                  : `${thread.messages.length} messages`}
          </span>
        </span>
      </button>
      {thread.agentSession && !readOnly && (
        <button
          type="button"
          className="icon-button question-thread-row-open"
          aria-label={`Resume ${thread.quote} in terminal`}
          title="Resume in terminal"
          onClick={() => void onResumeInTerminal(thread)}
        >
          <TerminalIcon />
        </button>
      )}
    </div>
  );
}
