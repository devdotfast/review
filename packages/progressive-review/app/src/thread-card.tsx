import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { AgentMarkdown, markdownExcerpt } from "./agent-markdown";
import {
  AddToReviewIcon,
  CloseIcon,
  ExpandIcon,
  MoreIcon,
  ResolveIcon,
  SparkIcon,
  SubmitIcon,
  TrashIcon,
} from "./icons";
import { useReview } from "./review-context";
import {
  type ThreadMessage,
  type ThreadView,
  threadRelativeTimeLabel,
} from "./review-threads";
import { readReviewUiState, writeReviewUiState } from "./review-ui-state";
import { useThreadTargetState } from "./thread-target-model";

/**
 * The one thread surface (Notion-style): quoted anchor with an accent bar,
 * name + time + body per message — agent answers render as equal
 * participants — and a reply row that reveals its controls on focus.
 * The caller chooses the presentation with `variant`.
 */
export function ThreadCard({
  thread,
  variant,
  compact = false,
  quoteKind = "text",
  onActivate,
  onOpenInPanel,
  onMinimize,
  onResolve,
  onReply,
  onAskNow,
  onAddToReview,
  onEditMessage,
  onDelete,
  onDeleteMessage,
}: {
  thread: ThreadView;
  variant: "margin" | "popover" | "panel";
  compact?: boolean;
  quoteKind?: "text" | "line";
  onActivate?: () => void;
  onOpenInPanel?: () => void;
  onMinimize?: () => void;
  onResolve?: (resolved: boolean) => void;
  onReply?: (body: string) => void;
  onAskNow?: (body: string) => void | boolean | Promise<void | boolean>;
  onAddToReview?: (body: string) => void | boolean | Promise<void | boolean>;
  onEditMessage?: (messageId: string, body: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  onDeleteMessage?: (messageId: string) => void | Promise<void>;
}): ReactElement {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const currentTargetState = useThreadTargetState(thread.target);
  const targetState = thread.targetState ?? currentTargetState;
  const outdated = targetState.state === "outdated";

  useEffect(() => {
    setEditingMessageId(null);
  }, [thread.key]);

  const classes = [
    "thread-card",
    `thread-card--${variant}`,
    compact ? "thread-card--compact" : "thread-card--expanded",
    thread.resolved ? "thread-card--resolved" : "",
    outdated ? "thread-card--outdated" : "",
    hasStatusPill(thread.clientStatus) ? "thread-card--has-status" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (compact) {
    // Notion-style collapsed thread: first message, a "Show N replies" hint
    // for the folded middle, and the latest message.
    const first = thread.messages[0];
    const last = thread.messages.length > 1 ? thread.messages.at(-1) : null;
    const hiddenCount = Math.max(0, thread.messages.length - 2);
    return (
      <button
        type="button"
        className={classes}
        data-thread-key={thread.key}
        onClick={onActivate}
      >
        <div className="thread-message-head">
          <strong>{first?.by ?? "You"}</strong>
          <span>{threadRelativeTimeLabel(first?.at ?? thread.latestAt)}</span>
          {thread.resolved && <em className="thread-resolved-tag">Resolved</em>}
          {outdated && <em className="thread-outdated-tag">Outdated</em>}
          <ThreadStatusPill status={thread.clientStatus} />
        </div>
        {variant === "panel" && (
          <ThreadQuote quote={thread.quote} kind={quoteKind} />
        )}
        {outdated && <ThreadTargetStatus reason={targetState.reason} />}
        {first && <ThreadCompactBody message={first} />}
        {hiddenCount > 0 && (
          <div className="thread-show-replies">
            Show {hiddenCount === 1 ? "1 reply" : `${hiddenCount} replies`}
          </div>
        )}
        {last && (
          <>
            <div className="thread-message-head">
              <strong>{last.by}</strong>
              <span>{threadRelativeTimeLabel(last.at)}</span>
            </div>
            <ThreadCompactBody message={last} />
          </>
        )}
      </button>
    );
  }

  return (
    <section
      className={classes}
      data-thread-key={thread.key}
      aria-label="Comment thread"
    >
      {(variant !== "panel" || onDelete || onResolve || onMinimize) && (
        <div className="thread-actions">
          {onDelete && (
            <button
              type="button"
              className={
                variant === "panel"
                  ? "icon-button thread-header-quiet-button"
                  : "icon-button"
              }
              aria-label="Delete thread"
              title="Delete thread"
              onClick={() => void onDelete()}
            >
              <TrashIcon />
            </button>
          )}
          {variant === "panel" && onMinimize && (
            <button
              type="button"
              className="icon-button thread-header-quiet-button"
              aria-label="Minimize thread"
              title="Minimize thread"
              onClick={onMinimize}
            >
              <span aria-hidden="true">−</span>
            </button>
          )}
          {onResolve && (
            <button
              type="button"
              className={
                variant === "panel"
                  ? "icon-button thread-header-quiet-button"
                  : "icon-button"
              }
              aria-label={thread.resolved ? "Unresolve" : "Resolve"}
              title={thread.resolved ? "Unresolve" : "Resolve"}
              onClick={() => onResolve(!thread.resolved)}
            >
              <ResolveIcon />
            </button>
          )}
          {variant !== "panel" && onOpenInPanel && (
            <button
              type="button"
              className="icon-button"
              aria-label="Open in side panel"
              title="Open in side panel"
              onClick={onOpenInPanel}
            >
              <ExpandIcon />
            </button>
          )}
        </div>
      )}
      <ThreadScroll variant={variant} messageCount={thread.messages.length}>
        {variant === "panel" && (
          <ThreadQuote quote={thread.quote} kind={quoteKind} />
        )}
        {outdated && <ThreadTargetStatus reason={targetState.reason} />}
        {thread.resolved && (
          <div className="thread-resolved-banner">
            <span>Resolved</span>
            {onResolve && (
              <button type="button" onClick={() => onResolve(false)}>
                Reopen
              </button>
            )}
          </div>
        )}
        {thread.messages.map((message, index) =>
          editingMessageId === message.id && onEditMessage ? (
            <ThreadMessageEditView
              key={`${message.id}:edit`}
              message={message}
              onCancel={() => setEditingMessageId(null)}
              onSubmit={(body) => {
                void onEditMessage(message.id, body);
                setEditingMessageId(null);
              }}
            />
          ) : (
            <ThreadMessageView
              key={message.id}
              message={message}
              headSlot={
                <>
                  {message.userAuthored &&
                  (onEditMessage || onDeleteMessage) ? (
                    <ThreadMessageActions
                      onEdit={
                        onEditMessage
                          ? () => setEditingMessageId(message.id)
                          : undefined
                      }
                      onDelete={
                        onDeleteMessage
                          ? () => onDeleteMessage(message.id)
                          : undefined
                      }
                    />
                  ) : null}
                  {index === 0 ? (
                    <ThreadStatusPill status={thread.clientStatus} />
                  ) : null}
                </>
              }
            />
          ),
        )}
      </ThreadScroll>
      {onAskNow && onAddToReview && !thread.resolved ? (
        <ThreadComposer
          kind="new-thread"
          placeholder="Ask or add to review..."
          onAskNow={onAskNow}
          onAddToReview={onAddToReview}
        />
      ) : onReply && !thread.resolved ? (
        <ThreadComposer
          placeholder="Reply..."
          submitLabel="Reply"
          onSubmit={onReply}
        />
      ) : null}
    </section>
  );
}

function ThreadTargetStatus({
  reason,
}: {
  reason: "edited" | "gone";
}): ReactElement {
  return (
    <div className="thread-target-status">
      <strong>Outdated</strong>
      <span>
        {reason === "edited"
          ? "The targeted content was edited."
          : "The targeted content no longer exists."}
      </span>
    </div>
  );
}

/* No "failed" entry: nothing sets a thread's clientStatus to "error". A failed
   submission is reported once by the corner action, not per thread. */
const STATUS_PILL_LABEL: Partial<
  Record<NonNullable<ThreadView["clientStatus"]>, string>
> = {
  draft: "draft",
  submitting: "saving",
};

/** True when this status warrants the corner pill (unpublished states). */
function hasStatusPill(status?: ThreadView["clientStatus"]): boolean {
  return status !== undefined && status in STATUS_PILL_LABEL;
}

/**
 * Corner pill marking a thread's unpublished state (draft / saving / failed).
 * Sits in the card's top-right and shows in both compact and expanded cards.
 */
function ThreadStatusPill({
  status,
}: {
  status?: ThreadView["clientStatus"];
}): ReactElement | null {
  if (!hasStatusPill(status)) return null;
  return (
    <span className={`thread-status-pill thread-status-pill--${status}`}>
      <span className="thread-status-pill-dot" aria-hidden="true" />
      {STATUS_PILL_LABEL[status as keyof typeof STATUS_PILL_LABEL]}
    </span>
  );
}

/**
 * The thread body: capped height with its own scrollbar in margin/popover
 * presentations, plus a "See more" affordance while more of the thread is
 * below the fold (the panel scrolls itself, so no cap there).
 */
function ThreadScroll({
  variant,
  messageCount,
  children,
}: {
  variant: "margin" | "popover" | "panel";
  messageCount: number;
  children: ReactNode;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollMore, setCanScrollMore] = useState(false);

  const measure = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    setCanScrollMore(
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 8,
    );
  };

  useLayoutEffect(measure, [messageCount, variant]);

  if (variant === "panel") {
    return <div className="thread-body">{children}</div>;
  }

  return (
    <div className="thread-body">
      <div className="thread-scroll" ref={scrollRef} onScroll={measure}>
        {children}
      </div>
      {canScrollMore && (
        <button
          type="button"
          className="thread-see-more"
          onClick={() => {
            const scroll = scrollRef.current;
            scroll?.scrollBy({
              top: scroll.clientHeight * 0.8,
              behavior: "smooth",
            });
          }}
        >
          ↓ See more
        </button>
      )}
    </div>
  );
}

/**
 * Whether a line-clamped element is actually hiding something. Re-measures on
 * resize, since a card's width tracks the gutter and a body that wraps to two
 * lines at one width fits on one at another.
 */
function useClampedOverflow(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  content: unknown,
): boolean {
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    const measure = () =>
      setClamped(element.scrollHeight - element.clientHeight > 1);
    // Measured eagerly as well as observed: the observer's first callback
    // lands after paint, which would flash a frame without the hint.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active, content]);

  return clamped;
}

/**
 * A collapsed message body. Agent answers are flattened to their text content
 * so the preview never shows raw `**` syntax nor rich layout, and since the
 * CSS clamp on its own only leaves an ellipsis, a muted hint reads as "there
 * is more here", not "that is the whole message".
 */
function ThreadCompactBody({
  message,
}: {
  message: ThreadMessage;
}): ReactElement {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const body = message.agentMarkdown
    ? markdownExcerpt(message.body)
    : message.body;
  const clamped = useClampedOverflow(bodyRef, true, body);

  return (
    <>
      <div className="thread-compact-body" ref={bodyRef}>
        {body}
      </div>
      {clamped && <div className="thread-expand-hint">Show more</div>}
    </>
  );
}

function ThreadQuote({
  quote,
  kind = "text",
}: {
  quote: string;
  kind?: "text" | "line";
}): ReactElement | null {
  if (!quote) return null;
  if (kind === "line") {
    return <span className="panel-thread-line-chip">{quote}</span>;
  }
  return (
    <div className="thread-quote">
      <i aria-hidden="true" />
      <span>{quote}</span>
    </div>
  );
}

function ThreadMessageActions({
  onEdit,
  onDelete,
}: {
  onEdit?: () => void;
  onDelete?: () => void | Promise<void>;
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (!menu || menu.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  return (
    <div className="thread-message-menu" ref={menuRef}>
      <button
        type="button"
        className="icon-button thread-message-menu-button"
        aria-label="Message actions"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreIcon />
      </button>
      {menuOpen ? (
        <div className="thread-menu-popover" role="menu">
          {onEdit ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
            >
              Edit
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              role="menuitem"
              className="thread-menu-danger"
              onClick={() => {
                setMenuOpen(false);
                void onDelete();
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThreadMessageView({
  message,
  headSlot,
}: {
  message: ThreadMessage;
  headSlot?: ReactElement | null;
}): ReactElement {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const isErrorBody = Boolean(message.error && message.error === message.body);
  const stderr = message.stderr;

  // Long messages truncate with a Read more toggle, so one verbose agent
  // answer doesn't swallow the margin.
  const clamped = useClampedOverflow(bodyRef, !expanded, message.body);

  return (
    <div
      className={
        message.running
          ? "thread-message thread-message--running"
          : "thread-message"
      }
    >
      <div className="thread-message-head">
        <strong>{message.by}</strong>
        <span>{threadRelativeTimeLabel(message.at)}</span>
        {headSlot}
      </div>
      <div
        ref={bodyRef}
        className={
          "thread-message-body" +
          (expanded ? "" : " thread-message-body--clamped") +
          (isErrorBody ? " thread-message-body--error" : "")
        }
      >
        {message.agentMarkdown ? (
          <AgentMarkdown source={message.body} />
        ) : (
          message.body
        )}
      </div>
      {message.error && message.body && !isErrorBody && (
        <div className="thread-message-error">{message.error}</div>
      )}
      {stderr && (
        <details className="thread-message-stderr">
          <summary>stderr</summary>
          <pre>{stderr}</pre>
        </details>
      )}
      {(clamped || expanded) && (
        <button
          type="button"
          className="thread-read-more"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      )}
    </div>
  );
}

function ThreadMessageEditView({
  message,
  onSubmit,
  onCancel,
}: {
  message: ThreadMessage;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="thread-message thread-message--editing">
      <div className="thread-message-head">
        <strong>{message.by}</strong>
        <span>{threadRelativeTimeLabel(message.at)}</span>
      </div>
      <ThreadComposer
        placeholder="Edit comment..."
        submitLabel="Save"
        autoFocus
        initialDraft={message.body}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </div>
  );
}

export type ComposeVerb = "ask-now" | "add-to-review";

const DEFAULT_COMPOSE_VERBS: readonly ComposeVerb[] = [
  "ask-now",
  "add-to-review",
];
export type ComposeVerbMenuPlacement = "above" | "below";

export function composeVerbMenuPlacement(input: {
  controlTop: number;
  controlBottom: number;
  menuHeight: number;
  viewportHeight: number;
  gap?: number;
}): ComposeVerbMenuPlacement {
  const gap = input.gap ?? 7;
  const roomBelow = input.viewportHeight - input.controlBottom;
  const roomAbove = input.controlTop;
  return roomBelow < input.menuHeight + gap && roomAbove > roomBelow
    ? "above"
    : "below";
}

const COMPOSE_VERB_DETAILS: Record<
  ComposeVerb,
  { label: string; description: string }
> = {
  "ask-now": {
    label: "Ask now",
    description: "The agent answers immediately in this thread.",
  },
  "add-to-review": {
    label: "Add to review",
    description: "Included when you submit; answered in the next round.",
  },
};

interface ThreadComposerCommonProps {
  placeholder: string;
  autoFocus?: boolean;
  preventFocusScroll?: boolean;
  initialDraft?: string;
  onCancel?: () => void;
  onDraftStateChange?: (hasText: boolean) => void;
  /** Reports every text change so a host can restore it across remounts
   *  (the draft surface moves between margin and popover containers). */
  onDraftTextChange?: (text: string) => void;
}

type ThreadComposerProps = ThreadComposerCommonProps &
  (
    | {
        kind?: "message";
        submitLabel: string;
        onSubmit: (body: string) => void | boolean | Promise<void | boolean>;
      }
    | {
        kind: "new-thread";
        initialVerb?: ComposeVerb;
        verbs?: readonly ComposeVerb[];
        onAskNow: (body: string) => void | boolean | Promise<void | boolean>;
        onAddToReview: (
          body: string,
        ) => void | boolean | Promise<void | boolean>;
      }
  );

/**
 * Notion-style composer: replies use the compact inline send affordance;
 * new threads use the persisted split verb control.
 */
export function ThreadComposer(props: ThreadComposerProps): ReactElement {
  const {
    placeholder,
    autoFocus = false,
    preventFocusScroll = false,
    initialDraft = "",
    onCancel,
    onDraftStateChange,
    onDraftTextChange,
  } = props;
  const isNewThread = props.kind === "new-thread";
  const initialVerb = isNewThread ? props.initialVerb : undefined;
  const requestedVerbs =
    isNewThread && props.kind === "new-thread"
      ? (props.verbs ?? DEFAULT_COMPOSE_VERBS)
      : DEFAULT_COMPOSE_VERBS;
  const availableVerbs = requestedVerbs;
  const [composing, setComposing] = useState(
    autoFocus || Boolean(initialDraft),
  );
  const [draft, setDraft] = useState(initialDraft);
  /* The primary verb follows the context, not a remembered preference: ask
     until a review batch is open, then add to it. A sticky last-used verb made
     the button mean different things on identical-looking screens. */
  const [verb, setVerb] = useState<ComposeVerb>(() => {
    if (!isNewThread) return "ask-now";
    const preferred = initialVerb ?? "ask-now";
    return availableVerbs.includes(preferred) ? preferred : availableVerbs[0]!;
  });
  const [verbMenuOpen, setVerbMenuOpen] = useState(false);
  const [verbMenuPlacement, setVerbMenuPlacement] =
    useState<ComposeVerbMenuPlacement>("below");
  const draftHasTextRef = useRef(Boolean(initialDraft.trim()));
  const draftRef = useRef(initialDraft);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const verbControlRef = useRef<HTMLDivElement | null>(null);
  const verbMenuRef = useRef<HTMLDivElement | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!isNewThread || !initialVerb) return;
    setVerb(initialVerb);
  }, [initialVerb, isNewThread]);

  useEffect(() => {
    if (!verbMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const control = verbControlRef.current;
      if (!control || control.contains(event.target as Node)) return;
      setVerbMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setVerbMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [verbMenuOpen]);

  useLayoutEffect(() => {
    if (!verbMenuOpen) return;
    const control = verbControlRef.current;
    const menu = verbMenuRef.current;
    if (!control || !menu) return;
    const controlRect = control.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    setVerbMenuPlacement(
      composeVerbMenuPlacement({
        controlTop: controlRect.top,
        controlBottom: controlRect.bottom,
        menuHeight: menuRect.height,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [verbMenuOpen]);

  useLayoutEffect(() => {
    if (!composing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    autosize(textarea);
    textarea.focus({ preventScroll: preventFocusScroll });
  }, [composing, preventFocusScroll]);

  const setDraftValue = (nextDraft: string) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    onDraftTextChange?.(nextDraft);
    const hasText = Boolean(nextDraft.trim());
    if (draftHasTextRef.current === hasText) return;
    draftHasTextRef.current = hasText;
    onDraftStateChange?.(hasText);
  };

  /**
   * Sends the draft with an explicit verb. The chevron menu calls this, so a
   * menu item performs its action instead of re-arming the primary button.
   */
  const submitWithVerb = async (chosen: ComposeVerb) => {
    const body = draft.trim();
    if (!body || props.kind !== "new-thread") return;
    flushSync(() => {
      setDraftValue("");
      setVerbMenuOpen(false);
    });
    const onSubmit =
      chosen === "ask-now" ? props.onAskNow : props.onAddToReview;
    try {
      if ((await onSubmit(body)) === false) {
        if (!draftRef.current.trim()) setDraftValue(body);
        return;
      }
    } catch (error) {
      if (!draftRef.current.trim()) setDraftValue(body);
      throw error;
    }
    if (!draftRef.current.trim()) setComposing(autoFocus);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    // Commit the controlled input first. A parent update must not retain it.
    flushSync(() => {
      setDraftValue("");
      setVerbMenuOpen(false);
    });
    try {
      if (props.kind === "new-thread") {
        const onSubmit =
          verb === "ask-now" ? props.onAskNow : props.onAddToReview;
        if (!onSubmit) {
          throw new Error(`Compose verb "${verb}" has no submit handler.`);
        }
        if ((await onSubmit(body)) === false) {
          if (!draftRef.current.trim()) setDraftValue(body);
          return;
        }
      } else if ((await props.onSubmit(body)) === false) {
        if (!draftRef.current.trim()) setDraftValue(body);
        return;
      }
    } catch (error) {
      if (!draftRef.current.trim()) setDraftValue(body);
      throw error;
    }
    if (!draftRef.current.trim()) setComposing(autoFocus);
  };

  if (!composing) {
    return (
      <button
        type="button"
        className="thread-reply-row"
        onClick={() => setComposing(true)}
      >
        {placeholder}
      </button>
    );
  }

  const textareaProps = {
    ref: textareaRef,
    value: draft,
    placeholder,
    rows: 1,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDraftValue(event.currentTarget.value);
      autosize(event.currentTarget);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!draft.trim()) {
          if (onCancel) onCancel();
          else setComposing(false);
        } else {
          event.currentTarget.blur();
        }
        return;
      }
      if (event.key !== "Enter") return;
      const shouldSubmit =
        !event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey;
      if (!shouldSubmit) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    },
    onBlur: () => {
      if (!draft.trim() && !autoFocus) setComposing(false);
    },
  } as const;

  if (!isNewThread) {
    return (
      <form className="thread-compose thread-compose--inline" onSubmit={submit}>
        <textarea {...textareaProps} />
        <button
          type="submit"
          className="thread-compose-send"
          aria-label={props.submitLabel}
          title={props.submitLabel}
          disabled={!draft.trim()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <SubmitIcon />
        </button>
      </form>
    );
  }

  return (
    <form className="thread-compose" onSubmit={submit}>
      <textarea {...textareaProps} />
      <div className="thread-compose-footer">
        <div
          ref={verbControlRef}
          className={`thread-compose-verb thread-compose-verb--${verb}`}
        >
          <div className="thread-compose-verb-primary-wrap">
            <button
              type="submit"
              className="thread-compose-verb-primary"
              aria-describedby={tooltipId}
              disabled={!draft.trim()}
              onMouseDown={(event) => event.preventDefault()}
            >
              <ComposeVerbIcon verb={verb} />
              <span>{COMPOSE_VERB_DETAILS[verb].label}</span>
            </button>
            <div
              id={tooltipId}
              role="tooltip"
              className="thread-compose-verb-tooltip"
            >
              {COMPOSE_VERB_DETAILS[verb].description}
            </div>
          </div>
          {availableVerbs.length > 1 && (
            <button
              type="button"
              className="thread-compose-verb-chevron"
              aria-label="Choose ask action"
              aria-haspopup="menu"
              aria-expanded={verbMenuOpen}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setVerbMenuOpen((current) => !current)}
            >
              <span aria-hidden="true" />
            </button>
          )}
          {verbMenuOpen && (
            <div
              ref={verbMenuRef}
              className={`thread-compose-verb-menu thread-compose-verb-menu--${verbMenuPlacement}`}
              role="menu"
              aria-label="Ask action"
            >
              {availableVerbs.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="menuitem"
                  className="thread-compose-verb-option"
                  disabled={!draft.trim()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setVerbMenuOpen(false);
                    void submitWithVerb(candidate);
                  }}
                >
                  <ComposeVerbIcon verb={candidate} />
                  <span>
                    <strong>{COMPOSE_VERB_DETAILS[candidate].label}</strong>
                    <small>{COMPOSE_VERB_DETAILS[candidate].description}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

function ComposeVerbIcon({ verb }: { verb: ComposeVerb }): ReactElement {
  return verb === "ask-now" ? <SparkIcon /> : <AddToReviewIcon />;
}

/** Grow the textarea with its content (and shrink back), capped by CSS
 *  max-height, so the row is stable until the text actually wraps. */
function autosize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * Draft card for a new thread created from any review target.
 */
export function ThreadDraftCard({
  cardRef,
  quote,
  quoteKind = "text",
  variant,
  initialDraft,
  intent,
  error,
  verbs,
  onSubmitComment,
  onAskAgent,
  onCancel,
  onDraftStateChange,
  onDraftTextChange,
}: {
  cardRef?: Ref<HTMLElement>;
  quote: string;
  quoteKind?: "text" | "line";
  variant: "margin" | "popover" | "panel";
  initialDraft?: string;
  intent?: "comment" | "ask-agent";
  error?: string | null;
  verbs?: readonly ComposeVerb[];
  onSubmitComment: (body: string) => void | boolean | Promise<void | boolean>;
  onAskAgent: (body: string) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  onDraftStateChange?: (hasText: boolean) => void;
  onDraftTextChange?: (text: string) => void;
}): ReactElement {
  const { pendingCommentCount } = useReview();
  /* With no explicit intent the verb follows the batch: an open review means
     the next thing you write most likely belongs to it. */
  const initialVerb =
    intent === "ask-agent"
      ? "ask-now"
      : intent === "comment"
        ? "add-to-review"
        : pendingCommentCount > 0
          ? "add-to-review"
          : "ask-now";
  return (
    <section
      ref={cardRef}
      className={`thread-card thread-card--${variant} thread-card--expanded thread-card--draft`}
      aria-label="New thread"
    >
      <div className="thread-actions">
        <button
          type="button"
          className="icon-button"
          aria-label="Discard draft"
          onClick={onCancel}
        >
          <CloseIcon />
        </button>
      </div>
      <ThreadQuote quote={quote} kind={quoteKind} />
      {error ? (
        <div className="thread-draft-error" role="alert">
          {error}
        </div>
      ) : null}
      <ThreadComposer
        kind="new-thread"
        placeholder="Ask or add to review..."
        initialVerb={initialVerb}
        verbs={verbs}
        autoFocus
        preventFocusScroll={variant === "panel"}
        initialDraft={initialDraft}
        onAskNow={onAskAgent}
        onAddToReview={onSubmitComment}
        onCancel={onCancel}
        onDraftStateChange={onDraftStateChange}
        onDraftTextChange={onDraftTextChange}
      />
    </section>
  );
}
