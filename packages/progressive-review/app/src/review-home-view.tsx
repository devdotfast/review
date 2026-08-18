import type {
  ReviewCanvasHomeSetup,
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCliInstallStatus,
  ReviewDescriptor,
  ReviewListError,
} from "@dev.fast/review-protocol";
import {
  type ColumnDef,
  type Row,
  type SortingState,
  type Table,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Fragment,
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyMatches, fuzzySegments } from "../../src/fuzzy-match";
import { TARGET_LABELS } from "./agent-setup-card";
import { CopyPromptButton } from "./copy-prompt-button";
import { WelcomePage } from "./welcome-page";

export type ReviewHomeView = "cards" | "list";

export const REVIEW_HOME_VIEW_STORAGE_KEY = "dev.fast.review.homeView";

export const REVIEW_MIGRATION_PROMPT =
  "Use the local `review` CLI to migrate my Review data. Run `review migrate apply`. If a code comment position cannot be recovered, rerun `review migrate apply --force` to drop only the unrecoverable threads. Then restart Review and confirm that the Reviews and comments load.";

interface ReviewHomeProps {
  reviews: readonly ReviewDescriptor[];
  reviewErrors?: readonly ReviewListError[];
  onOpen(review: ReviewDescriptor): void;
  // Deletion is immediate and permanent, so only a dismissed review offers it.
  // Absent when the host does not support deletion.
  onDelete?(review: ReviewDescriptor): Promise<void>;
  // Dismissal is reversible and reaped later. Absent when the host does not
  // support them.
  onDismiss?(review: ReviewDescriptor): Promise<void>;
  onRestore?(review: ReviewDescriptor): Promise<void>;
  // Opens the review and pins its read-only source tree open. Absent when the
  // host cannot show the tree.
  onOpenSourceTree?(review: ReviewDescriptor): void;
  setup?: ReviewCanvasHomeSetup;
  // Present only while the list is empty: Home then renders Welcome.
  install?: ReviewCanvasInstallContent;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?(): void;
}

interface ReviewAttentionActions {
  onDismiss?(review: ReviewDescriptor): Promise<void>;
  onRestore?(review: ReviewDescriptor): Promise<void>;
  onOpenSourceTree?(review: ReviewDescriptor): void;
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

export function reviewAttentionOf(
  review: ReviewDescriptor,
): "new" | "viewed" | "dismissed" {
  if (review.dismissedAt) return "dismissed";
  return review.viewedAt ? "viewed" : "new";
}

/** Days left before the reaper deletes a dismissed review. */
export function reapCountdownLabel(
  review: ReviewDescriptor,
  now = Date.now(),
): string | null {
  if (!review.reapsAt) return null;
  const remainingMs = Date.parse(review.reapsAt) - now;
  if (!Number.isFinite(remainingMs)) return null;
  if (remainingMs <= 0) return "deletes soon";
  const days = Math.ceil(remainingMs / 86_400_000);
  return days === 1 ? "deletes tomorrow" : `deletes in ${days}d`;
}

interface ReviewWorkspace {
  path: string;
  label: string;
  branch: string | null;
  reviews: ReviewDescriptor[];
}

interface ReviewStatusDisplay {
  label: string;
  tone: "in-review" | "ready" | "submitted" | "dismissed";
}

export function ReviewHome({
  reviews,
  reviewErrors = [],
  onOpen,
  onDelete,
  onDismiss,
  onRestore,
  onOpenSourceTree,
  setup,
  install,
  onboarding,
  onOpenTutorial,
}: ReviewHomeProps) {
  const [view, setView] = useState<ReviewHomeView>(readStoredHomeView);
  const [showDismissed, setShowDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const actions = useMemo(
    () => ({ onDismiss, onRestore, onOpenSourceTree }),
    [onDismiss, onRestore, onOpenSourceTree],
  );
  const needle = query.trim();
  const found = useMemo(
    () => reviews.filter((review) => matchesQuery(review, needle)),
    [reviews, needle],
  );
  /* New first, then viewed. Dismissed leaves the main list entirely: it is the
     one group you asked to stop seeing. */
  const active = found.filter((review) => !review.dismissedAt);
  const dismissed = found.filter((review) => review.dismissedAt);
  const sortedActive = [...active].sort((left, right) => {
    const leftNew = left.viewedAt ? 1 : 0;
    const rightNew = right.viewedAt ? 1 : 0;
    return leftNew - rightNew;
  });
  const workspaces = groupReviewsByWorktree(sortedActive);

  const selectView = (next: ReviewHomeView) => {
    setView(next);
    try {
      globalThis.localStorage?.setItem(REVIEW_HOME_VIEW_STORAGE_KEY, next);
    } catch {
      // The desktop can disable DOM storage; the in-memory toggle still works.
    }
  };

  /* With nothing to list, Home is the Welcome rail rather than a zero state
     of its own: the same three steps, in the place the reader already is.
     Scan errors keep the list shell: its warning banner is the only pointer
     to broken reviews, and the Welcome rail would hide it. */
  if (reviews.length === 0 && reviewErrors.length === 0) {
    return (
      <WelcomePage
        install={install}
        onboarding={onboarding}
        onOpenTutorial={onOpenTutorial}
      />
    );
  }

  return (
    <main className="review-home" data-view={view}>
      <div className="review-home-scroll">
        <div className="review-home-content">
          {setup ? <SetupBanner setup={setup} /> : null}
          {reviewErrors.length > 0 ? (
            <ReviewScanWarning errors={reviewErrors} />
          ) : null}
          <div className="review-home-page-header">
            <h1>Reviews</h1>
            <div className="review-home-page-header-tools">
              <SearchBox query={query} onChange={setQuery} />
              <ViewToggle view={view} onChange={selectView} />
            </div>
          </div>
          {/* Keyed off the active list, not the whole result: a query that hits
              only dismissed reviews empties the main area, and the collapsed
              Dismissed count alone does not explain why. */}
          {needle && active.length === 0 ? (
            <p className="review-home-search-empty">
              {dismissed.length > 0
                ? `No active reviews match “${needle}”. Look in Dismissed below.`
                : `No reviews match “${needle}”.`}
            </p>
          ) : null}
          <SearchQueryContext.Provider value={needle}>
            <AttentionActionsContext.Provider value={actions}>
              {active.length === 0 ? null : view === "cards" ? (
                <CardView workspaces={workspaces} onOpen={onOpen} />
              ) : (
                <ListView reviews={sortedActive} onOpen={onOpen} />
              )}
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

export function ReviewMigrationWarning({
  errors,
}: {
  errors: readonly ReviewListError[];
}) {
  const migrationCount = errors.filter(
    (error) => error.code === "MIGRATION_REQUIRED",
  ).length;
  if (migrationCount === 0) return null;
  return (
    <section
      className="review-migration-warning"
      aria-label="Review migration required"
    >
      <span>
        {`${migrationCount} ${migrationCount === 1 ? "Review needs" : "Reviews need"} migration.`}
      </span>
      <CopyPromptButton prompt={REVIEW_MIGRATION_PROMPT} />
    </section>
  );
}

function ReviewScanWarning({ errors }: { errors: readonly ReviewListError[] }) {
  const hasMigration = errors.some(
    (error) => error.code === "MIGRATION_REQUIRED",
  );
  if (hasMigration) return <ReviewMigrationWarning errors={errors} />;
  return (
    <section className="review-scan-warning" aria-label="Review warnings">
      <span>{`${errors.length} ${errors.length === 1 ? "Review has" : "Reviews have"} issues.`}</span>
    </section>
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

function ViewToggle({
  view,
  onChange,
}: {
  view: ReviewHomeView;
  onChange(view: ReviewHomeView): void;
}) {
  return (
    <div className="review-home-view-toggle" role="group" aria-label="View">
      <button
        type="button"
        className={view === "cards" ? "is-active" : undefined}
        aria-label="Card view"
        aria-pressed={view === "cards"}
        onClick={() => onChange("cards")}
      >
        <GridIcon />
      </button>
      <button
        type="button"
        className={view === "list" ? "is-active" : undefined}
        aria-label="List view"
        aria-pressed={view === "list"}
        onClick={() => onChange("list")}
      >
        <ListIcon />
      </button>
    </div>
  );
}

/**
 * Dismissed reviews, collapsed by default and kept out of the workspace
 * grouping. Each row states its own deadline, so the reap never surprises.
 */
function DismissedSection({
  reviews,
  expanded,
  onToggle,
  onOpen,
  onDelete,
}: {
  reviews: readonly ReviewDescriptor[];
  expanded: boolean;
  onToggle(): void;
  onOpen(review: ReviewDescriptor): void;
  onDelete?(review: ReviewDescriptor): Promise<void>;
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
            <div key={review.uuid} className="review-home-dismissed-row">
              <button
                type="button"
                className="review-home-dismissed-open"
                disabled={!review.available}
                onClick={() => onOpen(review)}
              >
                <MatchedText text={reviewTitle(review)} />
              </button>
              <span className="review-home-dismissed-clock">
                {reapCountdownLabel(review) ?? "kept"}
              </span>
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

/** Undo. It clears the stamp, which also stops the reap clock. */
function RestoreReviewButton({ review }: { review: ReviewDescriptor }) {
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
  workspaces,
  onOpen,
}: {
  workspaces: readonly ReviewWorkspace[];
  onOpen(review: ReviewDescriptor): void;
}) {
  return (
    <div className="review-home-workspaces">
      {workspaces.map((workspace) => (
        <CardWorkspace
          key={workspace.path}
          workspace={workspace}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function CardWorkspace({
  workspace,
  onOpen,
}: {
  workspace: ReviewWorkspace;
  onOpen(review: ReviewDescriptor): void;
}) {
  return (
    <section className="review-home-workspace">
      <WorkspaceHeader workspace={workspace} />
      <div className="review-home-cards">
        {workspace.reviews.map((review) => (
          <ReviewCard key={review.uuid} review={review} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function ReviewCard({
  review,
  onOpen,
}: {
  review: ReviewDescriptor;
  onOpen(review: ReviewDescriptor): void;
}) {
  return (
    <div className="review-home-card-shell">
      <button
        type="button"
        className="review-home-card"
        disabled={!review.available}
        onClick={() => onOpen(review)}
      >
        <span className="review-home-card-main">
          <span className="review-home-review-title">
            <MatchedText text={reviewTitle(review)} />
          </span>
          <ReviewMeta review={review} />
        </span>
        <span className="review-home-card-footer">
          <StatusPill review={review} />
          <CommentCount count={review.commentCount ?? 0} compact />
        </span>
      </button>
      <DismissReviewButton review={review} />
    </div>
  );
}

/**
 * The one action an active review offers. One click: dismissal is reversible,
 * so it needs no arming step. It stays enabled for unavailable reviews so a
 * dead review can still leave the list.
 */
function DismissReviewButton({ review }: { review: ReviewDescriptor }) {
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
 * The most recently updated review whose source tree the workspace can open.
 * Requires a publish: an available-but-never-published review has no session
 * to acquire, so its pinned worktree cannot root the tree.
 */
function workspaceSourceReview(
  workspace: ReviewWorkspace,
): ReviewDescriptor | null {
  let selected: ReviewDescriptor | null = null;
  let selectedUpdatedAt = 0;
  for (const review of workspace.reviews) {
    if (!review.available || !review.lastPublishedAt) continue;
    const updatedAt = reviewUpdatedAtMs(review);
    if (!selected || updatedAt > selectedUpdatedAt) {
      selected = review;
      selectedUpdatedAt = updatedAt;
    }
  }
  return selected;
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
  review: ReviewDescriptor;
  onDelete(review: ReviewDescriptor): Promise<void>;
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

function ListView({
  reviews,
  onOpen,
}: {
  reviews: readonly ReviewDescriptor[];
  onOpen(review: ReviewDescriptor): void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const data = useMemo(() => [...reviews], [reviews]);
  const table = useReactTable({
    columns: reviewListColumns,
    data,
    defaultColumn: reviewListDefaultColumn,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getRowId: (review) => review.uuid,
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      columnVisibility: { workspace: false },
      grouping: ["workspace"],
    },
    onSortingChange: setSorting,
    // Groups can never collapse: expansion is controlled and always on.
    state: { sorting, expanded: true },
  });

  return (
    <div className="review-home-list-scroll">
      <table
        className="review-home-list-table"
        aria-label="Reviews"
        style={{ width: table.getTotalSize() }}
      >
        <colgroup>
          {table.getVisibleLeafColumns().map((column) => (
            <col key={column.id} style={{ width: column.getSize() }} />
          ))}
        </colgroup>
        <tbody>
          {table.getRowModel().rows.map((row) =>
            row.getIsGrouped() ? (
              <Fragment key={row.id}>
                <WorkspaceGroupRow
                  row={row}
                  columnCount={table.getVisibleLeafColumns().length}
                />
                {row.getIsExpanded() ? (
                  <ReviewListColumnHeaders table={table} />
                ) : null}
              </Fragment>
            ) : (
              <ReviewRow key={row.id} row={row} onOpen={onOpen} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function ReviewListColumnHeaders({
  table,
}: {
  table: Table<ReviewDescriptor>;
}) {
  return table.getHeaderGroups().map((headerGroup) => (
    <tr className="review-home-list-columns" key={headerGroup.id}>
      {headerGroup.headers.map((header) => {
        const direction = header.column.getIsSorted();
        return (
          <th
            key={header.id}
            scope="col"
            aria-sort={
              direction === "asc"
                ? "ascending"
                : direction === "desc"
                  ? "descending"
                  : "none"
            }
          >
            {header.column.getCanSort() ? (
              <button
                type="button"
                aria-label={`Sort by ${String(header.column.columnDef.header)}`}
                onClick={header.column.getToggleSortingHandler()}
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                {direction ? (
                  <span
                    className="review-home-sort-indicator"
                    aria-hidden="true"
                  >
                    {direction === "asc" ? "↑" : "↓"}
                  </span>
                ) : null}
              </button>
            ) : header.isPlaceholder ? null : (
              flexRender(header.column.columnDef.header, header.getContext())
            )}
          </th>
        );
      })}
    </tr>
  ));
}

function WorkspaceGroupRow({
  row,
  columnCount,
}: {
  row: Row<ReviewDescriptor>;
  columnCount: number;
}) {
  const path = row.getValue<string>("workspace");
  const workspace: ReviewWorkspace = {
    path,
    label: worktreeLabel(path),
    branch: readableSourceBranch(row.original.sourceBranch),
    reviews: row.subRows.map((child) => child.original),
  };

  return (
    <tr className="review-home-list-workspace-row">
      <th colSpan={columnCount} scope="rowgroup">
        <WorkspaceHeader workspace={workspace} />
      </th>
    </tr>
  );
}

function ReviewRow({
  row,
  onOpen,
}: {
  row: Row<ReviewDescriptor>;
  onOpen(review: ReviewDescriptor): void;
}) {
  const review = row.original;
  const open = () => {
    if (review.available) onOpen(review);
  };
  return (
    <tr
      className="review-home-list-row"
      aria-disabled={!review.available}
      tabIndex={review.available ? 0 : -1}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}

const reviewListColumns: ColumnDef<ReviewDescriptor>[] = [
  {
    id: "workspace",
    accessorKey: "worktreePath",
    enableSorting: false,
  },
  {
    id: "review",
    accessorFn: reviewTitle,
    header: "Review",
    size: 400,
    sortDescFirst: false,
    cell: ({ row }) => (
      <span className="review-home-review-title">
        <MatchedText text={reviewTitle(row.original)} />
      </span>
    ),
  },
  {
    id: "pr",
    accessorFn: (review) => review.pullRequestNumber ?? undefined,
    header: "PR",
    size: 74,
    sortDescFirst: false,
    sortUndefined: "last",
    cell: ({ row }) => (
      <span className="review-home-pr">
        {row.original.pullRequestNumber
          ? `PR #${row.original.pullRequestNumber}`
          : "—"}
      </span>
    ),
  },
  {
    id: "files",
    accessorFn: (review) => review.diffStats?.fileCount,
    header: "Files",
    size: 68,
    sortUndefined: "last",
    cell: ({ row }) => <>{row.original.diffStats?.fileCount ?? "—"}</>,
  },
  {
    id: "changes",
    accessorFn: (review) =>
      review.diffStats
        ? review.diffStats.additions + review.diffStats.deletions
        : undefined,
    header: "Changes",
    size: 130,
    sortUndefined: "last",
    cell: ({ row }) => {
      const stats = row.original.diffStats;
      return stats ? (
        <span className="review-home-changes">
          <span className="review-home-added">+{stats.additions}</span>
          <span className="review-home-removed">−{stats.deletions}</span>
        </span>
      ) : (
        <>—</>
      );
    },
  },
  {
    id: "status",
    accessorFn: (review) => statusDisplay(review).label,
    header: "Status",
    size: 146,
    sortDescFirst: false,
    cell: ({ row }) => <StatusPill review={row.original} />,
  },
  {
    id: "comments",
    accessorFn: (review) => review.commentCount ?? 0,
    header: "Comments",
    size: 72,
    cell: ({ row }) => <CommentCount count={row.original.commentCount ?? 0} />,
  },
  {
    id: "updated",
    accessorFn: (review) => reviewUpdatedAtMs(review),
    header: "Updated",
    size: 130,
    cell: ({ row }) => (
      <span className="review-home-updated">
        {formatRelativeTime(reviewUpdatedAt(row.original))}
      </span>
    ),
  },
  {
    id: "actions",
    header: "",
    size: 44,
    enableSorting: false,
    cell: ({ row }) => <DismissReviewButton review={row.original} />,
  },
];

// Group headers do not display aggregates. Keeping their sortable values empty
// preserves workspace order while TanStack sorts the leaf reviews within them.
const reviewListDefaultColumn = {
  aggregationFn: () => undefined,
} satisfies Partial<ColumnDef<ReviewDescriptor>>;

function WorkspaceHeader({ workspace }: { workspace: ReviewWorkspace }) {
  const { onOpenSourceTree } = useContext(AttentionActionsContext);
  const review = onOpenSourceTree ? workspaceSourceReview(workspace) : null;
  const name = (
    <strong>
      <MatchedText text={workspace.label} />/
    </strong>
  );
  return (
    <div className="review-home-workspace-header review-home-workspace-header--group">
      {onOpenSourceTree && review ? (
        <button
          type="button"
          className="review-home-workspace-link"
          aria-label={`Browse ${workspace.label} source`}
          title="Browse the read-only source tree"
          onClick={() => onOpenSourceTree(review)}
        >
          {name}
        </button>
      ) : (
        name
      )}
      <span>
        {workspace.path}
        {workspace.branch ? ` · ${workspace.branch}` : ""}
      </span>
      {onOpenSourceTree && review ? (
        <button
          type="button"
          className="review-home-workspace-view"
          title="Browse the read-only source tree"
          onClick={() => onOpenSourceTree(review)}
        >
          View worktree →
        </button>
      ) : null}
    </div>
  );
}

function ReviewMeta({ review }: { review: ReviewDescriptor }) {
  const stats = review.diffStats;
  return (
    <span className="review-home-card-meta">
      {review.pullRequestNumber ? (
        <span className="review-home-pr">PR #{review.pullRequestNumber}</span>
      ) : null}
      {stats ? (
        <>
          <span>{countLabel(stats.fileCount, "file")}</span>
          <span className="review-home-changes">
            <span className="review-home-added">+{stats.additions}</span>
            <span className="review-home-removed">−{stats.deletions}</span>
          </span>
        </>
      ) : null}
      <span>updated {formatRelativeTime(reviewUpdatedAt(review))}</span>
    </span>
  );
}

function StatusPill({ review }: { review: ReviewDescriptor }) {
  const status = statusDisplay(review);
  return (
    <span className={`review-home-status review-home-status--${status.tone}`}>
      <StatusIcon tone={status.tone} />
      <span>{status.label}</span>
    </span>
  );
}

function StatusIcon({ tone }: { tone: ReviewStatusDisplay["tone"] }) {
  const path =
    tone === "in-review"
      ? "M6 3.3v3l2 1.2"
      : tone === "dismissed"
        ? "M3.5 6h5"
        : "M3.7 6.1l1.4 1.4 3.2-3.1";
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="5" />
      <path d={path} />
    </svg>
  );
}

function CommentCount({
  count,
  compact = false,
}: {
  count: number;
  compact?: boolean;
}) {
  if (count === 0) {
    return compact ? (
      <span />
    ) : (
      <span className="review-home-no-comments">—</span>
    );
  }
  return (
    <span
      className={
        compact ? "review-home-comments is-compact" : "review-home-comments"
      }
    >
      <CommentIcon />
      <span>{count}</span>
    </span>
  );
}

export function groupReviewsByWorktree(
  reviews: readonly ReviewDescriptor[],
): ReviewWorkspace[] {
  const groups = new Map<string, ReviewWorkspace>();
  for (const review of reviews) {
    let workspace = groups.get(review.worktreePath);
    if (!workspace) {
      workspace = {
        path: review.worktreePath,
        label: worktreeLabel(review.worktreePath),
        branch: readableSourceBranch(review.sourceBranch),
        reviews: [],
      };
      groups.set(review.worktreePath, workspace);
    }
    workspace.reviews.push(review);
  }
  return [...groups.values()];
}

// A publish does not touch review.mdx, so the document mtime alone goes stale
// on a review that was republished. Show the most recent activity instead.
export function reviewUpdatedAt(review: ReviewDescriptor): string | null {
  const candidates = [review.documentUpdatedAt, review.lastPublishedAt].filter(
    (value): value is string => Boolean(value),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** {@link reviewUpdatedAt} as epoch milliseconds; 0 when unknown. */
function reviewUpdatedAtMs(review: ReviewDescriptor): number {
  return Date.parse(reviewUpdatedAt(review) ?? "") || 0;
}

export function formatRelativeTime(
  timestamp: string | null | undefined,
  now = Date.now(),
): string {
  if (!timestamp) return "not published";
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

function statusDisplay(review: ReviewDescriptor): ReviewStatusDisplay {
  // The attention state outranks the handoff status: a dismissed review is
  // finished for the reader whatever the agent thinks.
  if (review.dismissedAt) {
    return { label: "Dismissed", tone: "dismissed" };
  }
  if (!review.viewedAt && review.presentedDocumentRevision) {
    return { label: "New", tone: "ready" };
  }
  if (review.status === "draft") {
    return { label: "Draft", tone: "in-review" };
  }
  if (review.status === "rejected") {
    return { label: "Rejected", tone: "dismissed" };
  }
  if (review.status === "accepted") {
    return { label: "Accepted", tone: "submitted" };
  }
  if (review.status === "awaiting-agent-updates") {
    return { label: "Awaiting updates", tone: "in-review" };
  }
  if (review.presentedDocumentRevision) {
    return { label: "Review ready", tone: "ready" };
  }
  return { label: "In review", tone: "in-review" };
}

function readStoredHomeView(): ReviewHomeView {
  try {
    return globalThis.localStorage?.getItem(REVIEW_HOME_VIEW_STORAGE_KEY) ===
      "list"
      ? "list"
      : "cards";
  } catch {
    return "cards";
  }
}

function reviewTitle(review: ReviewDescriptor): string {
  return review.title.trim() || "Untitled review";
}

function matchesQuery(review: ReviewDescriptor, query: string): boolean {
  return fuzzyMatches(
    query,
    reviewTitle(review),
    worktreeLabel(review.worktreePath),
  );
}

function readableSourceBranch(value: string | null): string | null {
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

function GridIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1" />
    </svg>
  );
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

function ListIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="3" cy="5" r="1" />
      <circle cx="3" cy="10" r="1" />
      <circle cx="3" cy="15" r="1" />
      <path d="M7 5h10M7 10h10M7 15h10" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V11H3.5A1.5 1.5 0 0 1 2 9.5v-6Z" />
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

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.6" y="2.6" width="12.8" height="3.4" rx="1" />
      <path d="M3 6v6.2a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 12.2V6" />
      <path d="M6.4 9h3.2" />
    </svg>
  );
}
