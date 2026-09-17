import type {
  CSSProperties,
  ComponentPropsWithoutRef,
  ReactElement,
  ReactNode,
  Ref,
} from "react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import type { ReviewComponentProps } from "../../src/review-document-data";
import { AuthoredCodeSurface } from "./authored-code-surface";
import { CodePeekCard } from "./CodePeek";
import { findWhitespaceNormalizedSpan } from "./highlighted-text";
import {
  useOptionalReviewSession,
  useReviewSession,
} from "./host/review-session";
import { CloseIcon, MapPinIcon } from "./icons";
import { newTabLinkProps } from "./link-props";
import { useReviewActions } from "./review-context";
import { useOptionalReviewPanelStore, useReviewPanel } from "./review-panel";
import type {
  GuidedTour,
  GuidedTourStop,
  PeekAnchor,
  ReviewPeekContent,
} from "./review-panel-model";
import { useReviewRoots } from "./review-root-context";
import type { ReviewSectionSummary } from "./review-section-summary";
import { useReviewUiState } from "./review-ui-state";
import { useBottomSheetResize } from "./side-panel-resizer";
import { TraceDocument, extractEventText } from "./trace-document";
import { useTutorialSection } from "./tutorial-section-context";
import { captureUiEvent } from "./ui-telemetry";
import { useAgentTrace } from "./use-agent-trace";

const TOUR_ACTIVE_TOP_SLACK_PX = 18;

/**
 * Shared shell for everything that docks into the right panel slot: side
 * peeks, commit diffs, and guided tours. Provides the uniform header (kicker,
 * title, close button), closes on Escape, and slides in with
 * the same animation everywhere. The panel occupies a grid column, so the
 * document reflows next to it instead of being overlaid.
 */
function ReviewPanelFrame({
  label,
  title,
  onClose,
  closeLabel,
  titleAccessory,
  floatingFooter,
  bodyRef,
  onBodyScroll,
  className,
  children,
}: {
  label: string;
  title?: string;
  onClose: () => void;
  closeLabel: string;
  titleAccessory?: ReactNode;
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
      if (event.key !== "Escape" || !appRef?.current) return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener("keydown", closeOnEscape);

    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [appRef, onClose]);

  // SAFETY: `--side-panel-bottom-fraction` is a CSS custom property, which
  // React forwards to style.setProperty; the CSSProperties typings only omit
  // custom names.
  const panelStyle = {
    "--side-panel-bottom-fraction": sheet.fraction,
  } as CSSProperties;

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
      style={panelStyle}
    >
      <div className="side-panel-sheet-resizer" {...sheet.separatorProps} />
      <header className="side-panel-header">
        <div className="side-panel-title">
          <span className="side-panel-kicker">{label}</span>
          {title && <h2>{title}</h2>}
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
      <div ref={bodyRef} className="review-panel-body" onScroll={onBodyScroll}>
        {children}
      </div>
      {floatingFooter}
    </aside>
  );
}

/**
 * Collapsible document section. The section owns its heading: it renders
 * `title` as the H2, with the id the projection pass assigned (or the block id
 * on the JSON path), and treats every child as body. Collapse state persists
 * per document+section in localStorage; sections marked `[collapsed]` in the
 * MDX start collapsed for first-time readers.
 */
export function ReviewSection({
  stateKey,
  title,
  defaultCollapsed = false,
  id,
  children,
  summary,
}: ReviewComponentProps<"ReviewSection"> & {
  stateKey?: string;
  id?: string;
  summary?: ReviewSectionSummary;
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useReviewUiState(
    stateKey ?? title,
    defaultCollapsed,
    {
      scope: "session",
      namespace: "section",
    },
  );

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tutorialSection = useTutorialSection(title);

  // The active tutorial chapter opens itself. Other chapters keep the
  // reader's own collapse state.
  useEffect(() => {
    if (tutorialSection.state === "active") setCollapsed(false);
  }, [setCollapsed, tutorialSection.state]);

  const toggleCollapsed = () => setCollapsed((current) => !current);

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
      data-tutorial-chapter-state={tutorialSection.state ?? undefined}
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
        <div className="review-section-heading">
          <h2 id={id}>{title}</h2>
        </div>
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
        {children}
      </div>
    </section>
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

interface ProsePeekAnchorProps {
  href: string;
  isOpen: boolean;
  onOpen: () => void;
  onAlreadyOpen?: () => void;
  className?: string;
  anchorId?: string;
  inertFallback?: ReactNode;
  children: ReactNode;
}

/**
 * Shared prose side-peek anchor primitive for AnchorLink and TraceQuote.
 * Renders an inline anchor with open-state styling, telemetry, and visibility retention.
 */
export function ProsePeekAnchor({
  href,
  isOpen,
  onOpen,
  onAlreadyOpen,
  className,
  anchorId,
  inertFallback,
  children,
}: ProsePeekAnchorProps) {
  const panelStore = useOptionalReviewPanelStore();
  const session = useOptionalReviewSession();

  if (!panelStore && inertFallback !== undefined) {
    return <>{inertFallback}</>;
  }

  return (
    <a
      href={href}
      className={className}
      data-review-anchor-id={anchorId}
      data-review-anchor-open={isOpen ? "true" : undefined}
      onClick={(event) => {
        event.preventDefault();

        if (isOpen && onAlreadyOpen) {
          onAlreadyOpen();

          return;
        }

        if (session) {
          captureUiEvent(session, "peek_opened", { via: "prose_link" });
        }

        onOpen();
        keepAnchorLinkVisible(event.currentTarget);
      }}
    >
      {children}
    </a>
  );
}

export function AnchorLink({
  anchor,
  children,
}: ReviewComponentProps<"AnchorLink"> & { children?: ReactNode }) {
  const openPeek = useReviewPanel((state) => state.openPeek);

  const peekOpen = useReviewPanel(
    (state) =>
      state.active?.kind === "peek" && state.active.anchor?.id === anchor.id,
  );

  return (
    <ProsePeekAnchor
      href={`#review-anchor-${anchor.id}`}
      anchorId={anchor.id}
      isOpen={peekOpen}
      onOpen={() => {
        openPeek({
          kind: "peek",
          anchor,
          content: { kind: "source", source: anchor.peek },
        });
      }}
    >
      {children}
    </ProsePeekAnchor>
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

/** The only top-level renderer for Review's detail panel modes. */
export function ReviewPanelHost() {
  const activePanel = useReviewPanel((state) => state.active);
  const close = useReviewPanel((state) => state.close);

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
          onClose={close}
        />
      ) : activePanel.kind === "commit-diff" ? (
        <CommitFileDiffPanel
          commit={activePanel.commit}
          file={activePanel.file}
          onClose={close}
        />
      ) : (
        <GuidedTourPanel
          tour={activePanel.tour}
          activeAnchor={activePanel.activeAnchor}
          revealRequest={activePanel.revealRequest}
          onActiveAnchorChange={activateTourAnchor}
          onClose={close}
        />
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

function TraceQuotePeekPanel({
  sessionId,
  trace,
  event,
  quote,
  onClose,
}: {
  sessionId: string;
  trace?: string;
  event?: number;
  quote: string;
  onClose: () => void;
}) {
  const { openTraceSession } = useReviewActions();
  const data = useAgentTrace(sessionId, trace);

  const traceEvents = data.status === "loaded" ? data.trace.events : undefined;

  const targetEventIndex = useMemo(() => {
    if (!traceEvents) return -1;

    if (event !== undefined && event >= 0 && event < traceEvents.length) {
      const e = traceEvents[event];
      const text = extractEventText(e);

      if (findWhitespaceNormalizedSpan(text, quote)) {
        return event;
      }
    }

    for (let i = 0; i < traceEvents.length; i++) {
      const text = extractEventText(traceEvents[i]);

      if (findWhitespaceNormalizedSpan(text, quote)) {
        return i;
      }
    }

    return -1;
  }, [traceEvents, event, quote]);

  const picks = useMemo(() => {
    if (!traceEvents || targetEventIndex === -1) return undefined;
    let turnStart = 0;

    for (let index = targetEventIndex; index >= 0; index -= 1) {
      if (traceEvents[index].kind === "user") {
        turnStart = index;
        break;
      }
    }

    let nextUserIndex = -1;

    for (
      let index = targetEventIndex + 1;
      index < traceEvents.length;
      index += 1
    ) {
      if (traceEvents[index].kind === "user") {
        nextUserIndex = index;
        break;
      }
    }

    const turnEnd =
      nextUserIndex === -1 ? traceEvents.length - 1 : nextUserIndex - 1;

    const events: [number, number] = [turnStart, turnEnd];

    return [{ events }];
  }, [traceEvents, targetEventIndex]);

  if (data.status === "loading" || data.status === "idle") {
    return (
      <ReviewPanelFrame
        className="side-peek trace-quote-panel"
        label="Agent trace"
        title={
          trace ? `${sessionId.slice(0, 8)} · ${trace}` : sessionId.slice(0, 8)
        }
        onClose={onClose}
        closeLabel="Close side peek"
      >
        <div className="side-peek-body">
          <p className="review-trace-note">Loading trace…</p>
        </div>
      </ReviewPanelFrame>
    );
  }

  if (data.status === "error") {
    return (
      <ReviewPanelFrame
        className="side-peek trace-quote-panel"
        label="Agent trace"
        title={sessionId.slice(0, 8)}
        onClose={onClose}
        closeLabel="Close side peek"
      >
        <div className="side-peek-body">
          <p className="review-trace-note review-trace-note--error">
            {data.error}
          </p>
        </div>
      </ReviewPanelFrame>
    );
  }

  const loadedTrace = data.trace;
  const events = loadedTrace.events;

  const headerAccessory = (
    <button
      type="button"
      className="review-trace-peek-open-full"
      onClick={() => {
        openTraceSession?.({
          sessionId,
          trace,
          eventIndex: targetEventIndex >= 0 ? targetEventIndex : undefined,
        });
        onClose();
      }}
    >
      Full Trace ↗
    </button>
  );

  return (
    <ReviewPanelFrame
      className="side-peek trace-quote-panel"
      label="Agent trace"
      title={
        loadedTrace.title ??
        (trace ? `${sessionId.slice(0, 8)} · ${trace}` : sessionId.slice(0, 8))
      }
      titleAccessory={headerAccessory}
      onClose={onClose}
      closeLabel="Close side peek"
    >
      <div className="side-peek-body">
        {targetEventIndex === -1 ? (
          <p className="review-trace-note">
            Quote not found in this session transcript.
          </p>
        ) : (
          <TraceDocument
            key={`${sessionId}-${trace ?? ""}-${targetEventIndex}-${quote}`}
            events={events}
            targetEventIndex={targetEventIndex}
            highlightQuote={quote}
            picks={picks}
            className="review-trace-events--scoped"
          />
        )}
      </div>
    </ReviewPanelFrame>
  );
}

function ReviewPeekPanel({
  anchor,
  content,
  onClose,
}: {
  anchor?: PeekAnchor;
  content: ReviewPeekContent;
  onClose: () => void;
}) {
  if (content.kind === "trace-quote") {
    return (
      <TraceQuotePeekPanel
        sessionId={content.sessionId}
        trace={content.trace}
        event={content.event}
        quote={content.quote}
        onClose={onClose}
      />
    );
  }

  if (!anchor) return null;

  return (
    <CodeReviewPeekPanel anchor={anchor} content={content} onClose={onClose} />
  );
}

function CodeReviewPeekPanel({
  anchor,
  content,
  onClose,
}: {
  anchor: PeekAnchor;
  content: Extract<
    ReviewPeekContent,
    { kind: "source" | "inline-code" | "explanation" }
  >;
  onClose: () => void;
}) {
  const { softwareMapEnabled, openSoftwareMapElement } = useReviewActions();

  return (
    <ReviewPanelFrame
      className="side-peek"
      label="Peek"
      title={anchor.title}
      onClose={onClose}
      closeLabel="Close side peek"
    >
      <div className="side-peek-body">
        {softwareMapEnabled && anchor.softwareMapPath ? (
          <div className="peek-actions">
            <button
              type="button"
              onClick={() => {
                openSoftwareMapElement(anchor.softwareMapPath!);
                onClose();
              }}
              className="icon-button icon-button--map"
              aria-label={`Show ${anchor.title} in software map`}
            >
              <MapPinIcon />
            </button>
          </div>
        ) : null}

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

  const captureAbandoned = useEffectEvent((step: number, steps: number) => {
    captureUiEvent(session, "tour_abandoned", { step, steps });
  });

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

      captureAbandoned(Math.max(0, index) + 1, tour.stops.length);
    };
  }, [session.appSessionId, tour.id, tour.stops.length]);

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
  const { softwareMapEnabled, openSoftwareMapElement } = useReviewActions();

  return (
    <div className="tour-stop-main">
      <header className="tour-stop-header">
        <div>
          <div className="tour-stop-count">
            Step {index + 1} of {total}
          </div>
          <div className="tour-stop-title-row">
            <h3>{stop.label}</h3>
          </div>
          {stop.detail && <p>{stop.detail}</p>}
        </div>
        {softwareMapEnabled && stop.anchor.softwareMapPath ? (
          <div className="peek-actions">
            <button
              type="button"
              className="icon-button icon-button--map"
              aria-label={`Show ${stop.anchor.title} in software map`}
              onClick={() => {
                openSoftwareMapElement(stop.anchor.softwareMapPath!);
                onClose();
              }}
            >
              <MapPinIcon />
            </button>
          </div>
        ) : null}
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

function ReviewPeekContentView({
  anchor,
  content,
  active,
  onNativeFocus,
}: {
  anchor: PeekAnchor;
  content: ReviewPeekContent;
  active?: boolean;
  onNativeFocus?: () => void;
}) {
  if (content.kind === "explanation") return <p>{content.text}</p>;

  if (content.kind === "source") {
    return (
      <CodePeekCard
        source={content.source}
        active={active}
        heightMode="content"
        onNativeFocus={onNativeFocus}
      />
    );
  }

  if (content.kind === "inline-code") {
    return (
      <AuthoredCodeSurface
        anchor={anchor}
        code={content.text}
        language={content.language}
      />
    );
  }

  return null;
}
