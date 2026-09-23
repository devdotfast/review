import type {
  ReviewApiSummary,
  ReviewCanvasHomeSetup,
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyMatches, fuzzySegments } from "../../src/fuzzy-match";
import { TARGET_LABELS } from "./agent-setup-card";
import { DiffCount } from "./diff-count";
import { ArchiveIcon } from "./review-corner-action";
import { WelcomePage } from "./welcome-page";

interface ReviewHomeProps {
  reviews: readonly ReviewApiSummary[];
  onOpen(review: ReviewApiSummary): void;
  // Deletion is immediate and permanent, so only a dismissed review offers it.
  // Absent when the host does not support deletion.
  onDelete?(review: ReviewApiSummary): Promise<void>;
  // Dismissal is reversible. Absent when the host does not
  // support them.
  onDismiss?(review: ReviewApiSummary): Promise<void>;
  onRestore?(review: ReviewApiSummary): Promise<void>;
  setup?: ReviewCanvasHomeSetup;
  // Present only while the list is empty: Home then renders Welcome.
  install?: ReviewCanvasInstallContent;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?(): void;
}

interface ReviewAttentionActions {
  onDismiss?(review: ReviewApiSummary): Promise<void>;
  onRestore?(review: ReviewApiSummary): Promise<void>;
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

interface ReviewTimeGroup {
  label: string;
  reviews: ReviewApiSummary[];
}

interface ReviewStatusDisplay {
  label: string;
  tone: "ready" | "dismissed";
}

export function ReviewHome({
  reviews,
  onOpen,
  onDelete,
  onDismiss,
  onRestore,
  setup,
  install,
  onboarding,
  onOpenTutorial,
}: ReviewHomeProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  const actions = useMemo(
    () => ({ onDismiss, onRestore }),
    [onDismiss, onRestore],
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
    () => listed.filter((review) => matchesQuery(review, needle)),
    [listed, needle],
  );

  /* Dismissed leaves the main list entirely: it is the one group you asked to
     stop seeing. */
  const active = found.filter((review) => !review.dismissedAt);

  const dismissed = found
    .filter((review) => review.dismissedAt)
    .sort(latestFirst);

  const groups = groupReviewsByTime(active, now);

  /* With nothing to list, Home is the Welcome rail rather than a zero state
     of its own: the same three steps, in the place the reader already is.
 */
  if (listed.length === 0) {
    return (
      <WelcomePage
        install={install}
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
            <h1>Reviews</h1>
            <div className="review-home-page-header-tools">
              <SearchBox query={query} onChange={setQuery} />
            </div>
          </div>
          {/* Keyed off the active list, not the whole result: a query that hits
              only dismissed reviews empties the main area, and the collapsed
              Dismissed count alone does not explain why. */}
          {needle && active.length === 0 && !scratchpadShown ? (
            <p className="review-home-search-empty">
              {dismissed.length > 0
                ? `No active reviews match “${needle}”. Look in Dismissed below.`
                : `No reviews match “${needle}”.`}
            </p>
          ) : null}
          <SearchQueryContext.Provider value={needle}>
            <AttentionActionsContext.Provider value={actions}>
              {scratchpadShown ? (
                <ScratchpadGroup review={scratchpad} onOpen={onOpen} />
              ) : null}
              {active.length > 0 ? (
                <CardView groups={groups} onOpen={onOpen} />
              ) : null}
              {dismissed.length > 0 ? (
                <DismissedSection
                  reviews={dismissed}
                  expanded={showDismissed}
                  onToggle={() => setShowDismissed((open) => !open)}
                  onOpen={onOpen}
                  onDelete={onDelete}
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

    return "Review is not set up for your coding agents yet.";
  }

  if (status.stale) {
    return "The installed Review skills are older than this app.";
  }

  const missing = status.agents.filter(
    (agent) => agent.present && !agent.installed,
  );

  if (missing.length > 0) {
    return `The Review skills are not installed for ${missing
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
        placeholder="Search"
        aria-label="Search reviews"
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
  reviews: readonly ReviewApiSummary[];
  expanded: boolean;
  onToggle(): void;
  onOpen(review: ReviewApiSummary): void;
  onDelete?(review: ReviewApiSummary): Promise<void>;
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
            <div key={review.reviewId} className="review-home-dismissed-row">
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
function RestoreReviewButton({ review }: { review: ReviewApiSummary }) {
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

function CardView({
  groups,
  onOpen,
}: {
  groups: readonly ReviewTimeGroup[];
  onOpen(review: ReviewApiSummary): void;
}) {
  return (
    <div className="review-home-workspaces">
      {groups.map((group) => (
        <section
          className="review-home-workspace"
          key={group.label}
          aria-label={group.label}
        >
          <TimeGroupHeader
            label={group.label}
            count={group.reviews.length}
            newestFirst
          />
          <div className="review-home-cards">
            {group.reviews.map((review) => (
              <ReviewCard
                key={review.reviewId}
                review={review}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ReviewCard({
  review,
  onOpen,
}: {
  review: ReviewApiSummary;
  onOpen(review: ReviewApiSummary): void;
}) {
  return (
    <div className="review-home-card-shell">
      <button
        type="button"
        className="review-home-card"
        onClick={() => onOpen(review)}
      >
        <span className="review-home-card-main">
          <span className="review-home-card-repository">
            <RepositoryName review={review} />
          </span>
          <span className="review-home-review-title">
            <MatchedText text={reviewTitle(review)} />
          </span>
          <ReviewMeta review={review} />
        </span>
        <span className="review-home-card-footer">
          <StatusPill review={review} />
          <span className="review-home-card-provenance">
            <ReviewWorktree review={review} />
            <span className="review-home-card-updated">
              {formatRelativeTime(reviewUpdatedAt(review))}
            </span>
          </span>
        </span>
      </button>
      <DismissReviewButton review={review} />
    </div>
  );
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
  review: ReviewApiSummary;
  onOpen(review: ReviewApiSummary): void;
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
function DismissReviewButton({ review }: { review: ReviewApiSummary }) {
  const { onDismiss } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onDismiss) return null;
  const title = reviewTitle(review);

  return (
    <button
      type="button"
      className="review-home-dismiss"
      aria-label={`Dismiss ${title}`}
      title="Dismiss review"
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
 * the review. Focus loss disarms it. Only a dismissed review offers it, so the
 * permanent action always follows the reversible one.
 */
function DeleteReviewButton({
  review,
  onDelete,
}: {
  review: ReviewApiSummary;
  onDelete(review: ReviewApiSummary): Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = reviewTitle(review);

  return (
    <button
      type="button"
      className={armed ? "review-home-delete is-armed" : "review-home-delete"}
      aria-label={armed ? `Confirm delete ${title}` : `Delete ${title}`}
      title={armed ? "Click again to delete" : "Delete review"}
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
      {armed ? "Delete?" : <TrashIcon />}
    </button>
  );
}

function TimeGroupHeader({
  label,
  count,
  newestFirst,
}: {
  label: string;
  count: number;
  newestFirst?: boolean;
}) {
  return (
    <div className="review-home-workspace-header review-home-workspace-header--group">
      <strong>
        {label} · {count}
      </strong>
      {newestFirst ? <span>Newest first ↓</span> : null}
    </div>
  );
}

function RepositoryName({ review }: { review: ReviewApiSummary }) {
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

function ReviewWorktree({ review }: { review: ReviewApiSummary }) {
  const branch = readableSourceBranch(review.origin?.branch);
  const worktree = review.repositoryPath;

  const label = review.shared
    ? "Shared"
    : worktree
      ? worktreeLabel(worktree)
      : "Worktree unavailable";

  return (
    <span
      className="review-home-origin-worktree"
      title={[worktree, branch].filter(Boolean).join(" · ") || label}
    >
      <MatchedText text={label} />
    </span>
  );
}

function ReviewMeta({ review }: { review: ReviewApiSummary }) {
  const stats = review.diffStats;

  return (
    <span className="review-home-card-meta">
      {review.origin?.pullRequestNumber ? (
        <span className="review-home-pr">
          PR #{review.origin?.pullRequestNumber}
        </span>
      ) : null}
      {stats ? (
        <>
          <span>{countLabel(stats.fileCount, "file")}</span>
          <DiffCount additions={stats.additions} deletions={stats.deletions} />
        </>
      ) : null}
    </span>
  );
}

function StatusPill({ review }: { review: ReviewApiSummary }) {
  const status = statusDisplay(review);

  return (
    <span className={`review-home-status review-home-status--${status.tone}`}>
      <StatusIcon tone={status.tone} />
      <span>{status.label}</span>
    </span>
  );
}

function StatusIcon({ tone }: { tone: ReviewStatusDisplay["tone"] }) {
  const path = tone === "dismissed" ? "M3.5 6h5" : "M3.7 6.1l1.4 1.4 3.2-3.1";

  return (
    <svg aria-hidden="true" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="5" />
      <path d={path} />
    </svg>
  );
}

const REVIEW_TIME_PERIODS = ["Last day", "Last week", "Older"] as const;

function reviewTimePeriod(review: ReviewApiSummary, now: number): string {
  const age = now - reviewUpdatedAtMs(review);

  if (age < 24 * 60 * 60 * 1000) return "Last day";

  if (age < 7 * 24 * 60 * 60 * 1000) return "Last week";

  return "Older";
}

export function groupReviewsByTime(
  reviews: readonly ReviewApiSummary[],
  now = Date.now(),
): ReviewTimeGroup[] {
  const sorted = [...reviews].sort(latestFirst);

  return REVIEW_TIME_PERIODS.values()
    .map((label) => ({
      label,
      reviews: sorted.filter(
        (review) => reviewTimePeriod(review, now) === label,
      ),
    }))
    .filter((group) => group.reviews.length > 0)
    .toArray();
}

export function reviewUpdatedAt(review: ReviewApiSummary): string {
  return review.createdAt;
}

/** {@link reviewUpdatedAt} as epoch milliseconds; 0 when unknown. */
function reviewUpdatedAtMs(review: ReviewApiSummary): number {
  return Date.parse(reviewUpdatedAt(review) ?? "") || 0;
}

function latestFirst(left: ReviewApiSummary, right: ReviewApiSummary): number {
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

function statusDisplay(review: ReviewApiSummary): ReviewStatusDisplay {
  if (review.dismissedAt) return { label: "Dismissed", tone: "dismissed" };

  return { label: review.viewedAt ? "Review ready" : "New", tone: "ready" };
}

function reviewTitle(review: ReviewApiSummary): string {
  return review.title.trim() || "Untitled review";
}

function matchesQuery(review: ReviewApiSummary, query: string): boolean {
  return fuzzyMatches(
    query,
    reviewTitle(review),
    repositoryLabel(review),
    review.repositoryPath ?? "",
    review.origin?.branch ?? "",
  );
}

function repositoryLabel(review: ReviewApiSummary): string {
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
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.7 7v4M9.3 7v4" />
    </svg>
  );
}
