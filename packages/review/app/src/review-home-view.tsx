import type {
  ReviewApiSummary,
  ReviewCanvasHomeSetup,
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCliInstallStatus,
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
import { DiffCount } from "./diff-count";
import { ArchiveIcon } from "./review-corner-action";
import { WelcomePage } from "./welcome-page";

export type ReviewHomeView = "cards" | "list";

export const REVIEW_HOME_VIEW_STORAGE_KEY = "dev.fast.review.homeView";

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
  // Opens the review and pins its read-only source tree open. Absent when the
  // host cannot show the tree.
  onOpenSourceTree?(review: ReviewApiSummary): void;
  setup?: ReviewCanvasHomeSetup;
  // Present only while the list is empty: Home then renders Welcome.
  install?: ReviewCanvasInstallContent;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?(): void;
}

interface ReviewAttentionActions {
  onDismiss?(review: ReviewApiSummary): Promise<void>;
  onRestore?(review: ReviewApiSummary): Promise<void>;
  onOpenSourceTree?(review: ReviewApiSummary): void;
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

interface ReviewWorkspace {
  path: string;
  label: string;
  branch: string | null;
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
 */
  if (reviews.length === 0) {
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
  workspaces,
  onOpen,
}: {
  workspaces: readonly ReviewWorkspace[];
  onOpen(review: ReviewApiSummary): void;
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
  onOpen(review: ReviewApiSummary): void;
}) {
  return (
    <section className="review-home-workspace">
      <WorkspaceHeader workspace={workspace} />
      <div className="review-home-cards">
        {workspace.reviews.map((review) => (
          <ReviewCard key={review.reviewId} review={review} onOpen={onOpen} />
        ))}
      </div>
    </section>
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
          <span className="review-home-review-title">
            <MatchedText text={reviewTitle(review)} />
          </span>
          <ReviewMeta review={review} />
        </span>
        <span className="review-home-card-footer">
          <StatusPill review={review} />
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
 * The most recently updated review whose source tree the workspace can open.
 */
function workspaceSourceReview(
  workspace: ReviewWorkspace,
): ReviewApiSummary | null {
  let selected: ReviewApiSummary | null = null;
  let selectedUpdatedAt = 0;

  for (const review of workspace.reviews) {
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

function ListView({
  reviews,
  onOpen,
}: {
  reviews: readonly ReviewApiSummary[];
  onOpen(review: ReviewApiSummary): void;
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
    getRowId: (review) => review.reviewId,
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
  table: Table<ReviewApiSummary>;
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
  row: Row<ReviewApiSummary>;
  columnCount: number;
}) {
  const path = row.getValue<string>("workspace");

  const workspace: ReviewWorkspace = {
    path,
    label: row.original.repositoryName ?? worktreeLabel(path),
    branch: readableSourceBranch(row.original.origin?.branch),
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
  row: Row<ReviewApiSummary>;
  onOpen(review: ReviewApiSummary): void;
}) {
  const review = row.original;

  const open = () => {
    onOpen(review);
  };

  return (
    <tr
      className="review-home-list-row"
      tabIndex={0}
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

const reviewListColumns: ColumnDef<ReviewApiSummary>[] = [
  {
    id: "workspace",
    accessorFn: (review) => review.repositoryPath ?? review.pins.repositoryId,
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
    accessorFn: (review) => review.origin?.pullRequestNumber ?? undefined,
    header: "PR",
    size: 74,
    sortDescFirst: false,
    sortUndefined: "last",
    cell: ({ row }) => (
      <span className="review-home-pr">
        {row.original.origin?.pullRequestNumber
          ? `PR #${row.original.origin?.pullRequestNumber}`
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
} satisfies Partial<ColumnDef<ReviewApiSummary>>;

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
        {workspace.reviews[0]?.repositoryPath}
        {workspace.branch ? ` · ${workspace.branch}` : ""}
      </span>
      {onOpenSourceTree && review ? (
        <button
          type="button"
          className="review-home-workspace-view"
          title="Browse the read-only source tree"
          onClick={() => onOpenSourceTree(review)}
        >
          View source →
        </button>
      ) : null}
    </div>
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
      <span>updated {formatRelativeTime(reviewUpdatedAt(review))}</span>
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

export function groupReviewsByWorktree(
  reviews: readonly ReviewApiSummary[],
): ReviewWorkspace[] {
  const groups = new Map<string, ReviewWorkspace>();

  for (const review of reviews) {
    const path = review.repositoryPath ?? review.pins.repositoryId;
    let workspace = groups.get(path);

    if (!workspace) {
      workspace = {
        path,
        label:
          review.repositoryName ??
          worktreeLabel(review.repositoryPath ?? review.pins.repositoryId),
        branch: readableSourceBranch(review.origin?.branch),
        reviews: [],
      };
      groups.set(path, workspace);
    }

    workspace.reviews.push(review);
  }

  return [...groups.values()];
}

export function reviewUpdatedAt(review: ReviewApiSummary): string {
  return review.createdAt;
}

/** {@link reviewUpdatedAt} as epoch milliseconds; 0 when unknown. */
function reviewUpdatedAtMs(review: ReviewApiSummary): number {
  return Date.parse(reviewUpdatedAt(review) ?? "") || 0;
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

function reviewTitle(review: ReviewApiSummary): string {
  return review.title.trim() || "Untitled review";
}

function matchesQuery(review: ReviewApiSummary, query: string): boolean {
  return fuzzyMatches(
    query,
    reviewTitle(review),
    review.repositoryName ??
      worktreeLabel(review.repositoryPath ?? review.pins.repositoryId),
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.7 7v4M9.3 7v4" />
    </svg>
  );
}
