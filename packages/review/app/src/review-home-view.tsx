import type {
  ReviewCanvasHomeSetup,
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCanvasSetupActions,
  ReviewCliInstallStatus,
  SessionSummary,
} from "@dev.fast/review-protocol";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyMatches, fuzzySegments } from "../../src/fuzzy-match";
import { TARGET_LABELS } from "./agent-setup-card";
import { ArchiveIcon } from "./review-corner-action";
import { useDismissOnOutside } from "./use-dismiss-on-outside";
import { useTopbarPopover } from "./use-topbar-popover";
import { WelcomePage } from "./welcome-page";

interface ReviewHomeProps {
  reviews: readonly SessionSummary[];
  onOpen(review: SessionSummary): void;
  // Deletion is permanent and requires an arming click.
  // Absent when the host does not support deletion.
  onDelete?(review: SessionSummary): Promise<void>;
  // Dismissal is reversible. Absent when the host does not
  // support them.
  onDismiss?(review: SessionSummary): Promise<void>;
  onRestore?(review: SessionSummary): Promise<void>;
  setup?: ReviewCanvasHomeSetup;
  // Present only while the list is empty: Home then renders Welcome.
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?(): void;
}

interface ReviewAttentionActions {
  onDelete?(review: SessionSummary): Promise<void>;
  onDismiss?(review: SessionSummary): Promise<void>;
  onRestore?(review: SessionSummary): Promise<void>;
}

/* Passed by context rather than through every list and card signature: the
   actions are optional and only leaf controls use them. */
const AttentionActionsContext = createContext<ReviewAttentionActions>({});

/* The search query reaches the leaves the same way, and for the same reason:
   every title and worktree label marks its own hit, and threading a prop
   through the card tree and a table column would touch far more code. */
const SearchQueryContext = createContext("");

/** A label with the characters the query hit marked. */
function MatchedText({ text }: { text: string }) {
  const query = useContext(SearchQueryContext);
  const segments = fuzzySegments(query, text);

  // One segment can also mean the query matched the whole label, so check that
  // it is the unmatched one before skipping the marks.
  if (segments.length === 1 && !segments[0].matched) return <>{text}</>;

  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          // Segments are positional, so the index is the only stable key.
          // eslint-disable-next-line react/no-array-index-key
          <mark key={index}>{segment.text}</mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

export function ReviewHome({
  reviews,
  onOpen,
  onDelete,
  onDismiss,
  onRestore,
  setup,
  install,
  setupActions,
  onboarding,
  onOpenTutorial,
}: ReviewHomeProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const [, setNow] = useState(Date.now);

  const [deletions, setDeletions] = useState(
    new Map<string, "pending" | "deleted">(),
  );

  const [deleteError, setDeleteError] = useState<string>();

  // Keep successful deletions hidden until the catalog acknowledges removal.
  useEffect(() => {
    setDeletions((current) => {
      const next = new Map(current);

      for (const [id, status] of current) {
        if (
          status === "deleted" &&
          !reviews.some((review) => review.sessionId === id)
        ) {
          next.delete(id);
        }
      }

      return next.size === current.size ? current : next;
    });
  }, [reviews, deletions]);

  const deleteReview = useCallback(
    async (review: SessionSummary) => {
      if (!onDelete) return;
      setDeleteError(undefined);
      setDeletions((current) =>
        new Map(current).set(review.sessionId, "pending"),
      );

      try {
        await onDelete(review);
        setDeletions((current) =>
          new Map(current).set(review.sessionId, "deleted"),
        );
      } catch {
        setDeletions((current) => {
          const next = new Map(current);
          next.delete(review.sessionId);

          return next;
        });
        setDeleteError(
          `Could not delete “${reviewTitle(review)}”. Please try again.`,
        );
      }
    },
    [onDelete],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  const actions = useMemo(
    () => ({
      onDismiss,
      onRestore,
      onDelete: onDelete ? deleteReview : undefined,
    }),
    [onDismiss, onRestore, onDelete, deleteReview],
  );

  const needle = query.trim();

  // The one scratchpad is the last group on Home, outside the workspaces,
  // their chronological order and their lifecycle. The filter still finds it.
  const scratchpad = reviews.find((review) => review.kind === "scratchpad");

  const listed = useMemo(
    () => reviews.filter((review) => review.kind !== "scratchpad"),
    [reviews],
  );

  const scratchpadShown =
    scratchpad !== undefined && matchesQuery(scratchpad, needle);

  const found = useMemo(
    () =>
      listed.filter(
        (review) =>
          !deletions.has(review.sessionId) && matchesQuery(review, needle),
      ),
    [listed, needle, deletions],
  );

  /* Dismissed leaves the main list entirely: it is the one group you asked to
     stop seeing. */
  const active = found.filter((review) => !review.dismissedAt);

  const dismissed = found
    .filter((review) => review.dismissedAt)
    .sort(latestFirst);

  /* With nothing to list, Home is the Welcome rail rather than a zero state
     of its own: the same three steps, in the place the reader already is.
 */
  if (listed.length === 0 && deletions.size === 0 && !deleteError) {
    return (
      <WelcomePage
        install={install}
        setupActions={setupActions}
        onboarding={onboarding}
        onOpenTutorial={onOpenTutorial}
      />
    );
  }

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content">
          {setup ? <SetupBanner setup={setup} /> : null}
          <div className="review-home-page-header">
            <h1>Sessions</h1>
            <div className="review-home-page-header-tools">
              <SearchBox query={query} onChange={setQuery} />
            </div>
          </div>
          {deleteError ? <p role="alert">{deleteError}</p> : null}
          {/* Keyed off the active list, not the whole result: a query that hits
              only dismissed reviews empties the main area, and the collapsed
              Dismissed count alone does not explain why. */}
          {needle && active.length === 0 && !scratchpadShown ? (
            <p className="review-home-search-empty">
              {dismissed.length > 0
                ? `No active sessions match “${needle}”. Look in Dismissed below.`
                : `No sessions match “${needle}”.`}
            </p>
          ) : null}
          <SearchQueryContext.Provider value={needle}>
            <AttentionActionsContext.Provider value={actions}>
              {scratchpadShown ? (
                <ScratchpadGroup review={scratchpad} onOpen={onOpen} />
              ) : null}
              {active.length > 0 ? (
                <ReviewTable reviews={active} onOpen={onOpen} />
              ) : null}
              {dismissed.length > 0 ? (
                <DismissedSection
                  reviews={dismissed}
                  expanded={showDismissed}
                  onToggle={() => setShowDismissed((open) => !open)}
                  onOpen={onOpen}
                  onDelete={actions.onDelete}
                />
              ) : null}
            </AttentionActionsContext.Provider>
          </SearchQueryContext.Provider>
        </div>
      </div>
    </main>
  );
}

/**
 * One-line callout shown only when the install needs attention: setup was
 * never finished, the installed skills are stale, or a detected agent has no
 * skills. Declined consent means the user opted out — no banner.
 */
function SetupBanner({ setup }: { setup: ReviewCanvasHomeSetup }) {
  const message = setupBannerMessage(setup.status);

  if (!message) return null;

  return (
    <div className="review-home-setup-banner">
      <span>{message}</span>
      <button type="button" onClick={setup.open}>
        Set up
      </button>
    </div>
  );
}

export function setupBannerMessage(
  status: ReviewCliInstallStatus,
): string | null {
  if (!status.cli || status.stamp?.consent === "declined") return null;

  if (!status.stamp || status.stamp.consent === "skipped") {
    if (status.agents.some((agent) => agent.installed)) return null;
    const present = status.agents.filter((agent) => agent.present);

    if (present.length === 0) return null;

    return "Whiteboard is not set up for your coding agents yet.";
  }

  if (status.stale) {
    return "The installed Whiteboard skills are older than this app.";
  }

  const missing = status.agents.filter(
    (agent) => agent.present && !agent.installed,
  );

  if (missing.length > 0) {
    return `The Whiteboard skills are not installed for ${missing
      .map((agent) => TARGET_LABELS[agent.target])
      .join(", ")}.`;
  }

  // Trace capture is experimental and opt-in, so Home never nags about it.
  return null;
}

/**
 * Filter-as-you-type over the review title and the worktree name — the two
 * labels the page already shows. Escape clears it.
 */
function SearchBox({
  query,
  onChange,
}: {
  query: string;
  onChange(query: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="review-home-search">
      <SearchIcon />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="Search sessions"
        aria-label="Search sessions"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {query ? (
        <button
          type="button"
          className="review-home-search-clear"
          aria-label="Clear search"
          // Clearing unmounts this button, so hand focus back to the field
          // rather than letting it fall to the body.
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <ClearIcon />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Dismissed reviews, collapsed by default and kept out of the workspace
 * grouping. Reviews stay saved until the reader deletes them.
 */
function DismissedSection({
  reviews,
  expanded,
  onToggle,
  onOpen,
  onDelete,
}: {
  reviews: readonly SessionSummary[];
  expanded: boolean;
  onToggle(): void;
  onOpen(review: SessionSummary): void;
  onDelete?(review: SessionSummary): Promise<void>;
}) {
  return (
    <section className="review-home-dismissed" aria-label="Dismissed reviews">
      <button
        type="button"
        className="review-home-dismissed-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span>Dismissed</span>
        <span className="review-home-dismissed-count">{reviews.length}</span>
      </button>
      {expanded ? (
        <div className="review-home-dismissed-rows">
          {reviews.map((review) => (
            <div key={review.sessionId} className="review-home-dismissed-row">
              <button
                type="button"
                className="review-home-dismissed-open"
                onClick={() => onOpen(review)}
              >
                <MatchedText text={reviewTitle(review)} />
              </button>
              <span className="review-home-dismissed-clock">kept</span>
              <RestoreReviewButton review={review} />
              {onDelete ? (
                <DeleteReviewButton review={review} onDelete={onDelete} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Undo clears the dismissal stamp. */
function RestoreReviewButton({ review }: { review: SessionSummary }) {
  const { onRestore } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onRestore) return null;

  return (
    <button
      type="button"
      className="review-home-restore"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void onRestore(review)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      Undo
    </button>
  );
}

type ReviewSort = "newest" | "oldest" | "updated" | "pr" | "title";

function ReviewTable({
  reviews,
  onOpen,
}: {
  reviews: readonly SessionSummary[];
  onOpen(review: SessionSummary): void;
}) {
  const [repository, setRepository] = useState("");
  const [sort, setSort] = useState<ReviewSort>("newest");
  const repositories = [...new Set(reviews.map(repositoryLabel))].sort();

  const filtered = reviews.filter(
    (review) => !repository || repositoryLabel(review) === repository,
  );

  const sorted = [...filtered].sort((left, right) => {
    const created = (review: SessionSummary) =>
      Date.parse(review.firstCreatedAt ?? review.createdAt) || 0;

    switch (sort) {
      case "oldest":
        return created(left) - created(right);
      case "updated":
        return latestFirst(left, right);
      case "pr":
        return (
          (right.origin?.pullRequestNumber ?? -1) -
            (left.origin?.pullRequestNumber ?? -1) || latestFirst(left, right)
        );
      case "title":
        return reviewTitle(left).localeCompare(reviewTitle(right));
      default:
        return created(right) - created(left);
    }
  });

  return (
    <section className="review-home-table-section" aria-label="Reviews">
      <div className="review-home-table-toolbar">
        <span>{countLabel(filtered.length, "review")}</span>
        <div className="review-home-table-controls">
          <TableMenu
            label="Filter"
            ariaLabel="Filter by repository"
            value={repository}
            options={[
              { value: "", label: "All repos" },
              ...repositories.map((name) => ({ value: name, label: name })),
            ]}
            onChange={setRepository}
          />
          <TableMenu<ReviewSort>
            label="Sort"
            ariaLabel="Sort reviews"
            value={sort}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "updated", label: "Recently updated" },
              { value: "pr", label: "PR number" },
              { value: "title", label: "Title A–Z" },
            ]}
            onChange={setSort}
          />
        </div>
      </div>
      <div className="review-home-table-scroll">
        <table className="review-home-table">
          <colgroup>
            <col className="review-home-col-pr" />
            <col />
            <col className="review-home-col-branch" />
            <col className="review-home-col-date" />
            <col className="review-home-col-date" />
            <col className="review-home-col-action" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">PR</th>
              <th scope="col">Title</th>
              <th scope="col">Head branch</th>
              <th scope="col">Created</th>
              <th scope="col">Updated</th>
              <th scope="col">
                <span className="review-home-action-heading">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((review) => (
              <tr key={review.sessionId} onClick={() => onOpen(review)}>
                <td>
                  {review.origin?.pullRequestNumber
                    ? `#${review.origin.pullRequestNumber}`
                    : "—"}
                </td>
                <td>
                  <button
                    className="review-home-table-open"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(review);
                    }}
                    title={reviewTitle(review)}
                  >
                    <span className="review-home-review-title">
                      <MatchedText text={reviewTitle(review)} />
                    </span>
                    <span
                      className="review-home-table-repository"
                      title={
                        review.repositoryPath ??
                        (review.shared ? "Shared review" : undefined)
                      }
                    >
                      <RepositoryName review={review} />
                    </span>
                  </button>
                </td>
                <td title={review.origin?.branch}>
                  <MatchedText
                    text={readableSourceBranch(review.origin?.branch) ?? "—"}
                  />
                </td>
                <td title={review.firstCreatedAt}>
                  {formatCreatedTime(review.firstCreatedAt)}
                </td>
                <td title={reviewUpdatedAt(review)}>
                  {formatRelativeTime(reviewUpdatedAt(review))}
                </td>
                <td>
                  <ReviewRowActions review={review} />
                </td>
              </tr>
            ))}
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6}>No reviews match this repository.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReviewRowActions({ review }: { review: SessionSummary }) {
  const { onDelete } = useContext(AttentionActionsContext);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useTopbarPopover(open, control);

  useDismissOnOutside(control, open, setOpen);

  if (!onDelete) return <DismissReviewButton review={review} />;

  return (
    <div
      ref={control}
      className="review-home-row-actions"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="review-home-row-menu-trigger"
        aria-label={`Actions for ${reviewTitle(review)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="15.5" cy="10" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div
          ref={popover}
          popover="manual"
          role="menu"
          aria-label="Review actions"
          className="review-home-row-menu"
        >
          <DeleteReviewButton review={review} onDelete={onDelete} menu />
        </div>
      ) : null}
    </div>
  );
}

function TableMenu<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: "Filter" | "Sort";
  ariaLabel: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissOnOutside(container, open, setOpen);

  return (
    <div
      className="review-home-table-menu"
      ref={container}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="review-home-table-menu-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d={
              label === "Filter"
                ? "M3 5h14M6 10h8M8.5 15h3"
                : "M6 4v12m0 0-3-3m3 3 3-3M14 16V4m0 0-3 3m3-3 3 3"
            }
          />
        </svg>
        <span>{label}</span>
        <strong>
          {options.find((option) => option.value === value)?.label ?? value}
        </strong>
        <svg
          className="review-home-menu-chevron"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d={open ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="review-home-table-menu-options"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m5 10 3.5 3.5L15 6.5" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatCreatedTime(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";

  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The scratchpad's own group, last on Home: a header in the workspace
 * header's grammar, then one card in the review card's grammar. No status,
 * workspace or dismissal, since it has none.
 */
function ScratchpadGroup({
  review,
  onOpen,
}: {
  review: SessionSummary;
  onOpen(review: SessionSummary): void;
}) {
  const contents = review.contents;

  return (
    <section className="review-home-scratchpad" aria-label="Scratchpad">
      <div className="review-home-cards">
        <div className="review-home-card-shell">
          <button
            type="button"
            className="review-home-card review-home-scratchpad-card"
            onClick={() => onOpen(review)}
          >
            <span className="review-home-card-main">
              <span className="review-home-review-title">
                <PencilIcon />
                <MatchedText text={reviewTitle(review)} />
              </span>
              <span className="review-home-card-meta">
                {contents ? (
                  <>
                    <span>{countLabel(contents.blocks, "block")}</span>
                    <span>{countLabel(contents.diagrams, "diagram")}</span>
                  </>
                ) : null}
                <span>
                  updated {formatRelativeTime(reviewUpdatedAt(review))}
                </span>
              </span>
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}

function PencilIcon() {
  return (
    <svg
      className="review-home-scratchpad-glyph"
      aria-hidden="true"
      viewBox="0 0 16 16"
    >
      <path d="M3 13l1-4 7-7 3 3-7 7-4 1z" />
      <path d="M10 3l3 3" />
    </svg>
  );
}

/**
 * The one action an active review offers. One click: dismissal is reversible,
 * so it needs no arming step. It stays enabled for unavailable reviews so a
 * dead review can still leave the list.
 */
function DismissReviewButton({ review }: { review: SessionSummary }) {
  const { onDismiss } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onDismiss) return null;
  const title = reviewTitle(review);

  return (
    <button
      type="button"
      className="review-home-dismiss"
      aria-label={`Dismiss ${title}`}
      title="Dismiss session"
      disabled={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void onDismiss(review)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      <ArchiveIcon />
    </button>
  );
}

/**
 * Two-step delete: the first click arms the button, the second click deletes
 * the review. Focus loss disarms it. The row menu and dismissed section share
 * this arming step.
 */
function DeleteReviewButton({
  review,
  onDelete,
  menu = false,
}: {
  review: SessionSummary;
  onDelete(review: SessionSummary): Promise<void>;
  menu?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = reviewTitle(review);

  return (
    <button
      type="button"
      className={
        menu
          ? "review-home-menu-delete"
          : armed
            ? "review-home-delete is-armed"
            : "review-home-delete"
      }
      role={menu ? "menuitem" : undefined}
      aria-label={armed ? `Confirm delete ${title}` : `Delete ${title}`}
      title={armed ? "Confirm delete" : "Delete session"}
      disabled={busy}
      onBlur={() => setArmed(false)}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();

        if (!armed) {
          setArmed(true);

          return;
        }

        setBusy(true);
        void onDelete(review)
          .catch(() => undefined)
          .finally(() => {
            setBusy(false);
            setArmed(false);
          });
      }}
    >
      {menu ? (
        <>
          <TrashIcon />
          <span>{armed ? "Confirm delete" : "Delete review"}</span>
        </>
      ) : armed ? (
        "Delete?"
      ) : (
        <TrashIcon />
      )}
    </button>
  );
}

function RepositoryName({ review }: { review: SessionSummary }) {
  const label = repositoryLabel(review);
  const separator = label.lastIndexOf("/");

  return separator < 0 ? (
    <strong>
      <MatchedText text={label} />
    </strong>
  ) : (
    <>
      <span>
        <MatchedText text={label.slice(0, separator)} />
      </span>
      <span aria-hidden="true">/</span>
      <strong>
        <MatchedText text={label.slice(separator + 1)} />
      </strong>
    </>
  );
}

export function reviewUpdatedAt(review: SessionSummary): string {
  return review.createdAt;
}

/** {@link reviewUpdatedAt} as epoch milliseconds; 0 when unknown. */
function reviewUpdatedAtMs(review: SessionSummary): number {
  return Date.parse(reviewUpdatedAt(review) ?? "") || 0;
}

function latestFirst(left: SessionSummary, right: SessionSummary): number {
  return reviewUpdatedAtMs(right) - reviewUpdatedAtMs(left);
}

export function formatRelativeTime(
  timestamp: string | null | undefined,
  now = Date.now(),
): string {
  if (!timestamp) return "unknown";
  const then = Date.parse(timestamp);

  if (!Number.isFinite(then)) return "unknown";
  const elapsed = Math.max(0, now - then);

  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);

  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(then);
}

function reviewTitle(review: SessionSummary): string {
  return review.title.trim() || "Untitled session";
}

function matchesQuery(review: SessionSummary, query: string): boolean {
  return fuzzyMatches(
    query,
    reviewTitle(review),
    repositoryLabel(review),
    review.repositoryPath ?? "",
    review.origin?.branch ?? "",
  );
}

function repositoryLabel(review: SessionSummary): string {
  if (review.repositoryGroup) return review.repositoryGroup.label;

  if (review.shared?.cloneUrl) {
    try {
      return new URL(review.shared.cloneUrl).pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "");
    } catch {
      // Older imports may not have a valid remote URL.
    }
  }

  return (
    review.repositoryName ??
    worktreeLabel(review.repositoryPath ?? review.pins?.repositoryId ?? "")
  );
}

function readableSourceBranch(value: string | null | undefined): string | null {
  if (!value || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return null;

  return value;
}

function worktreeLabel(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);

  return parts.at(-1) ?? value;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2 13.5 13.5" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.5h13M8 5.5V4h4v1.5M5 5.5l.8 11h8.4l.8-11M8.3 8.5l.3 5M11.7 8.5l-.3 5" />
    </svg>
  );
}
