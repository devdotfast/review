import type {
  SessionSummary,
  WhiteboardCanvasInstallContent,
  WhiteboardCanvasOnboarding,
  WhiteboardCanvasSetupActions,
} from "@dev.fast/whiteboard-protocol";
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
import { useDismissOnOutside } from "./use-dismiss-on-outside";
import { useTopbarPopover } from "./use-topbar-popover";
import { WelcomePage } from "./welcome-page";
import { ArchiveIcon } from "./whiteboard-corner-action";

interface WhiteboardHomeProps {
  whiteboards: readonly SessionSummary[];
  onOpen(whiteboard: SessionSummary): void;
  // Deletion is permanent and requires an arming click.
  // Absent when the host does not support deletion.
  onDelete?(whiteboard: SessionSummary): Promise<void>;
  // Dismissal is reversible. Absent when the host does not
  // support them.
  onDismiss?(whiteboard: SessionSummary): Promise<void>;
  onRestore?(whiteboard: SessionSummary): Promise<void>;
  // Present only while the list is empty: Home then renders Welcome.
  install?: WhiteboardCanvasInstallContent;
  setupActions?: WhiteboardCanvasSetupActions;
  onboarding?: WhiteboardCanvasOnboarding;
  onOpenTutorial?(): void;
}

interface WhiteboardAttentionActions {
  onDelete?(whiteboard: SessionSummary): Promise<void>;
  onDismiss?(whiteboard: SessionSummary): Promise<void>;
  onRestore?(whiteboard: SessionSummary): Promise<void>;
}

/* Passed by context rather than through every list and card signature: the
   actions are optional and only leaf controls use them. */
const AttentionActionsContext = createContext<WhiteboardAttentionActions>({});

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

export function WhiteboardHome({
  whiteboards,
  onOpen,
  onDelete,
  onDismiss,
  onRestore,
  install,
  setupActions,
  onboarding,
  onOpenTutorial,
}: WhiteboardHomeProps) {
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
          !whiteboards.some((whiteboard) => whiteboard.sessionId === id)
        ) {
          next.delete(id);
        }
      }

      return next.size === current.size ? current : next;
    });
  }, [whiteboards, deletions]);

  const deleteWhiteboard = useCallback(
    async (whiteboard: SessionSummary) => {
      if (!onDelete) return;
      setDeleteError(undefined);
      setDeletions((current) =>
        new Map(current).set(whiteboard.sessionId, "pending"),
      );

      try {
        await onDelete(whiteboard);
        setDeletions((current) =>
          new Map(current).set(whiteboard.sessionId, "deleted"),
        );
      } catch {
        setDeletions((current) => {
          const next = new Map(current);
          next.delete(whiteboard.sessionId);

          return next;
        });
        setDeleteError(
          `Could not delete “${whiteboardTitle(whiteboard)}”. Please try again.`,
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
      onDelete: onDelete ? deleteWhiteboard : undefined,
    }),
    [onDismiss, onRestore, onDelete, deleteWhiteboard],
  );

  const needle = query.trim();

  // The one scratchpad is the last group on Home, outside the workspaces,
  // their chronological order and their lifecycle. The filter still finds it.
  const scratchpad = whiteboards.find(
    (whiteboard) => whiteboard.kind === "scratchpad",
  );

  const listed = useMemo(
    () => whiteboards.filter((whiteboard) => whiteboard.kind !== "scratchpad"),
    [whiteboards],
  );

  const scratchpadShown =
    scratchpad !== undefined && matchesQuery(scratchpad, needle);

  const found = useMemo(
    () =>
      listed.filter(
        (whiteboard) =>
          !deletions.has(whiteboard.sessionId) &&
          matchesQuery(whiteboard, needle),
      ),
    [listed, needle, deletions],
  );

  /* Dismissed leaves the main list entirely: it is the one group you asked to
     stop seeing. */
  const active = found.filter((whiteboard) => !whiteboard.dismissedAt);

  const dismissed = found
    .filter((whiteboard) => whiteboard.dismissedAt)
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
    <main className="whiteboard-home">
      <div className="whiteboard-home-scroll">
        <div className="whiteboard-home-content">
          <div className="whiteboard-home-page-header">
            <h1>Sessions</h1>
            <div className="whiteboard-home-page-header-tools">
              <SearchBox query={query} onChange={setQuery} />
            </div>
          </div>
          {deleteError ? <p role="alert">{deleteError}</p> : null}
          {/* Keyed off the active list, not the whole result: a query that hits
              only dismissed reviews empties the main area, and the collapsed
              Dismissed count alone does not explain why. */}
          {needle && active.length === 0 && !scratchpadShown ? (
            <p className="whiteboard-home-search-empty">
              {dismissed.length > 0
                ? `No active sessions match “${needle}”. Look in Dismissed below.`
                : `No sessions match “${needle}”.`}
            </p>
          ) : null}
          <SearchQueryContext.Provider value={needle}>
            <AttentionActionsContext.Provider value={actions}>
              {scratchpadShown ? (
                <ScratchpadGroup whiteboard={scratchpad} onOpen={onOpen} />
              ) : null}
              {active.length > 0 ? (
                <WhiteboardTable whiteboards={active} onOpen={onOpen} />
              ) : null}
              {dismissed.length > 0 ? (
                <DismissedSection
                  whiteboards={dismissed}
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
 * Filter-as-you-type over the whiteboard title and the worktree name — the two
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
    <div className="whiteboard-home-search">
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
          className="whiteboard-home-search-clear"
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
 * Dismissed sessions, collapsed by default and kept out of the workspace
 * grouping. Reviews stay saved until the reader deletes them.
 */
function DismissedSection({
  whiteboards,
  expanded,
  onToggle,
  onOpen,
  onDelete,
}: {
  whiteboards: readonly SessionSummary[];
  expanded: boolean;
  onToggle(): void;
  onOpen(whiteboard: SessionSummary): void;
  onDelete?(whiteboard: SessionSummary): Promise<void>;
}) {
  return (
    <section
      className="whiteboard-home-dismissed"
      aria-label="Dismissed sessions"
    >
      <button
        type="button"
        className="whiteboard-home-dismissed-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span>Dismissed</span>
        <span className="whiteboard-home-dismissed-count">
          {whiteboards.length}
        </span>
      </button>
      {expanded ? (
        <div className="whiteboard-home-dismissed-rows">
          {whiteboards.map((whiteboard) => (
            <div
              key={whiteboard.sessionId}
              className="whiteboard-home-dismissed-row"
            >
              <button
                type="button"
                className="whiteboard-home-dismissed-open"
                onClick={() => onOpen(whiteboard)}
              >
                <MatchedText text={whiteboardTitle(whiteboard)} />
              </button>
              <span className="whiteboard-home-dismissed-clock">kept</span>
              <RestoreWhiteboardButton whiteboard={whiteboard} />
              {onDelete ? (
                <DeleteWhiteboardButton
                  whiteboard={whiteboard}
                  onDelete={onDelete}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Undo clears the dismissal stamp. */
function RestoreWhiteboardButton({
  whiteboard,
}: {
  whiteboard: SessionSummary;
}) {
  const { onRestore } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onRestore) return null;

  return (
    <button
      type="button"
      className="whiteboard-home-restore"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void onRestore(whiteboard)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      Undo
    </button>
  );
}

type WhiteboardSort = "newest" | "oldest" | "updated" | "pr" | "title";

function WhiteboardTable({
  whiteboards,
  onOpen,
}: {
  whiteboards: readonly SessionSummary[];
  onOpen(whiteboard: SessionSummary): void;
}) {
  const [repository, setRepository] = useState("");
  const [sort, setSort] = useState<WhiteboardSort>("newest");
  const repositories = [...new Set(whiteboards.map(repositoryLabel))].sort();

  const filtered = whiteboards.filter(
    (whiteboard) => !repository || repositoryLabel(whiteboard) === repository,
  );

  const sorted = [...filtered].sort((left, right) => {
    const created = (whiteboard: SessionSummary) =>
      Date.parse(whiteboard.firstCreatedAt ?? whiteboard.createdAt) || 0;

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
        return whiteboardTitle(left).localeCompare(whiteboardTitle(right));
      default:
        return created(right) - created(left);
    }
  });

  return (
    <section className="whiteboard-home-table-section" aria-label="Whiteboards">
      <div className="whiteboard-home-table-toolbar">
        <span>{countLabel(filtered.length, "review")}</span>
        <div className="whiteboard-home-table-controls">
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
          <TableMenu<WhiteboardSort>
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
      <div className="whiteboard-home-table-scroll">
        <table className="whiteboard-home-table">
          <colgroup>
            <col className="whiteboard-home-col-pr" />
            <col />
            <col className="whiteboard-home-col-branch" />
            <col className="whiteboard-home-col-date" />
            <col className="whiteboard-home-col-date" />
            <col className="whiteboard-home-col-action" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">PR</th>
              <th scope="col">Title</th>
              <th scope="col">Head branch</th>
              <th scope="col">Created</th>
              <th scope="col">Updated</th>
              <th scope="col">
                <span className="whiteboard-home-action-heading">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((whiteboard) => (
              <tr key={whiteboard.sessionId} onClick={() => onOpen(whiteboard)}>
                <td>
                  {whiteboard.origin?.pullRequestNumber
                    ? `#${whiteboard.origin.pullRequestNumber}`
                    : "—"}
                </td>
                <td>
                  <button
                    className="whiteboard-home-table-open"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(whiteboard);
                    }}
                    title={whiteboardTitle(whiteboard)}
                  >
                    <span className="whiteboard-home-whiteboard-title">
                      <MatchedText text={whiteboardTitle(whiteboard)} />
                    </span>
                    <span
                      className="whiteboard-home-table-repository"
                      title={
                        whiteboard.repositoryPath ??
                        (whiteboard.shared ? "Shared review" : undefined)
                      }
                    >
                      <RepositoryName whiteboard={whiteboard} />
                    </span>
                  </button>
                </td>
                <td title={whiteboard.origin?.branch}>
                  <MatchedText
                    text={
                      readableSourceBranch(whiteboard.origin?.branch) ?? "—"
                    }
                  />
                </td>
                <td title={whiteboard.firstCreatedAt}>
                  {formatCreatedTime(whiteboard.firstCreatedAt)}
                </td>
                <td title={whiteboardUpdatedAt(whiteboard)}>
                  {formatRelativeTime(whiteboardUpdatedAt(whiteboard))}
                </td>
                <td>
                  <WhiteboardRowActions whiteboard={whiteboard} />
                </td>
              </tr>
            ))}
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6}>No whiteboards match this repository.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WhiteboardRowActions({ whiteboard }: { whiteboard: SessionSummary }) {
  const { onDelete } = useContext(AttentionActionsContext);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useTopbarPopover(open, control);

  useDismissOnOutside(control, open, setOpen);

  if (!onDelete) return <DismissWhiteboardButton whiteboard={whiteboard} />;

  return (
    <div
      ref={control}
      className="whiteboard-home-row-actions"
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
        className="whiteboard-home-row-menu-trigger"
        aria-label={`Actions for ${whiteboardTitle(whiteboard)}`}
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
          aria-label="Whiteboard actions"
          className="whiteboard-home-row-menu"
        >
          <DeleteWhiteboardButton
            whiteboard={whiteboard}
            onDelete={onDelete}
            menu
          />
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
      className="whiteboard-home-table-menu"
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
        className="whiteboard-home-table-menu-trigger"
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
          className="whiteboard-home-menu-chevron"
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
          className="whiteboard-home-table-menu-options"
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
  whiteboard,
  onOpen,
}: {
  whiteboard: SessionSummary;
  onOpen(whiteboard: SessionSummary): void;
}) {
  const contents = whiteboard.contents;

  return (
    <section className="whiteboard-home-scratchpad" aria-label="Scratchpad">
      <div className="whiteboard-home-cards">
        <div className="whiteboard-home-card-shell">
          <button
            type="button"
            className="whiteboard-home-card whiteboard-home-scratchpad-card"
            onClick={() => onOpen(whiteboard)}
          >
            <span className="whiteboard-home-card-main">
              <span className="whiteboard-home-whiteboard-title">
                <PencilIcon />
                <MatchedText text={whiteboardTitle(whiteboard)} />
              </span>
              <span className="whiteboard-home-card-meta">
                {contents ? (
                  <>
                    <span>{countLabel(contents.blocks, "block")}</span>
                    <span>{countLabel(contents.diagrams, "diagram")}</span>
                  </>
                ) : null}
                <span>
                  updated {formatRelativeTime(whiteboardUpdatedAt(whiteboard))}
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
      className="whiteboard-home-scratchpad-glyph"
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
function DismissWhiteboardButton({
  whiteboard,
}: {
  whiteboard: SessionSummary;
}) {
  const { onDismiss } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onDismiss) return null;
  const title = whiteboardTitle(whiteboard);

  return (
    <button
      type="button"
      className="whiteboard-home-dismiss"
      aria-label={`Dismiss ${title}`}
      title="Dismiss session"
      disabled={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void onDismiss(whiteboard)
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
function DeleteWhiteboardButton({
  whiteboard,
  onDelete,
  menu = false,
}: {
  whiteboard: SessionSummary;
  onDelete(whiteboard: SessionSummary): Promise<void>;
  menu?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = whiteboardTitle(whiteboard);

  return (
    <button
      type="button"
      className={
        menu
          ? "whiteboard-home-menu-delete"
          : armed
            ? "whiteboard-home-delete is-armed"
            : "whiteboard-home-delete"
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
        void onDelete(whiteboard)
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

function RepositoryName({ whiteboard }: { whiteboard: SessionSummary }) {
  const label = repositoryLabel(whiteboard);
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

export function whiteboardUpdatedAt(whiteboard: SessionSummary): string {
  return whiteboard.createdAt;
}

/** {@link reviewUpdatedAt} as epoch milliseconds; 0 when unknown. */
function whiteboardUpdatedAtMs(whiteboard: SessionSummary): number {
  return Date.parse(whiteboardUpdatedAt(whiteboard) ?? "") || 0;
}

function latestFirst(left: SessionSummary, right: SessionSummary): number {
  return whiteboardUpdatedAtMs(right) - whiteboardUpdatedAtMs(left);
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

function whiteboardTitle(whiteboard: SessionSummary): string {
  return whiteboard.title.trim() || "Untitled session";
}

function matchesQuery(whiteboard: SessionSummary, query: string): boolean {
  return fuzzyMatches(
    query,
    whiteboardTitle(whiteboard),
    repositoryLabel(whiteboard),
    whiteboard.repositoryPath ?? "",
    whiteboard.origin?.branch ?? "",
  );
}

function repositoryLabel(whiteboard: SessionSummary): string {
  if (whiteboard.repositoryGroup) return whiteboard.repositoryGroup.label;

  if (whiteboard.shared?.cloneUrl) {
    try {
      return new URL(whiteboard.shared.cloneUrl).pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "");
    } catch {
      // Older imports may not have a valid remote URL.
    }
  }

  return (
    whiteboard.repositoryName ??
    worktreeLabel(
      whiteboard.repositoryPath ?? whiteboard.pins?.repositoryId ?? "",
    )
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
