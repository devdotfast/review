import {
  type WhiteboardCommitSummary,
  type WhiteboardDiffFileWire,
} from "@dev.fast/whiteboard-protocol";
import { useMemo, useState } from "react";

import { DiffCount } from "./diff-count";
import { FileMark } from "./file-mark";
import { useWhiteboardSession } from "./host/whiteboard-session";
import { DisclosureChevron } from "./icons";
import { captureUiEvent } from "./ui-telemetry";
import { WhiteboardUnavailable } from "./whiteboard-empty-state";
import { useWhiteboardPanel } from "./whiteboard-panel";

type CommitFilesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; files: WhiteboardDiffFileWire[] };

export function WhiteboardCommitsView({
  commits,
  range,
  onOpenDiff,
}: {
  commits: readonly WhiteboardCommitSummary[];
  range: import("@dev.fast/whiteboard-protocol").WhiteboardCanvasRange;
  onOpenDiff: (commit: WhiteboardCommitSummary, via: "row") => void;
}) {
  if (range.sourceUnavailable) {
    return (
      <WhiteboardUnavailable
        role="status"
        title="Commits unavailable"
        message={range.sourceUnavailable}
      />
    );
  }

  return (
    <div className="whiteboard-commits-view">
      <div className="whiteboard-commits-column">
        <header className="whiteboard-commits-range">
          <div>
            <strong>{commits.length} commits</strong>
            <span>
              {range.baseRef}..{range.headRef}
            </span>
          </div>
          <div className="whiteboard-commits-range-shas">
            <span>base</span>
            <code>{range.baseCommit.slice(0, 8)}</code>
            <span>head</span>
            <code>{range.headCommit.slice(0, 8)}</code>
          </div>
        </header>
        <CommitGroups commits={commits} onOpenDiff={onOpenDiff} />
      </div>
    </div>
  );
}

function CommitGroups({
  commits,
  onOpenDiff,
}: {
  commits: readonly WhiteboardCommitSummary[];
  onOpenDiff: (commit: WhiteboardCommitSummary, via: "row") => void;
}) {
  const groups = useMemo(() => groupCommitsByDate(commits), [commits]);

  return groups.map((group) => (
    <section className="whiteboard-commit-group" key={group.key}>
      <div className="whiteboard-commit-date">
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="3" />
        </svg>
        <h2>Commits on {group.label}</h2>
      </div>
      <div className="whiteboard-commit-timeline">
        {group.commits.map((commit) => (
          <CommitRow
            key={commit.commit}
            commit={commit}
            onOpenDiff={onOpenDiff}
          />
        ))}
      </div>
    </section>
  ));
}

function CommitRow({
  commit,
  onOpenDiff,
}: {
  commit: WhiteboardCommitSummary;
  onOpenDiff: (commit: WhiteboardCommitSummary, via: "row") => void;
}) {
  const session = useWhiteboardSession();
  const openCommitDiff = useWhiteboardPanel((panel) => panel.openCommitDiff);
  const [expanded, setExpanded] = useState(false);
  const [filesState, setFilesState] = useState<CommitFilesState | null>(null);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    captureUiEvent(session, "commit_expanded", { expanded: next });

    if (!next || filesState) return;
    setFilesState({ status: "loading" });
    const diffView = session.bridge.diffView;

    const request = diffView.files({ commit: commit.commit });

    request
      .then((files) => setFilesState({ status: "loaded", files: [...files] }))
      .catch((cause: unknown) => {
        setFilesState({
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
  };

  const visibleFiles =
    filesState?.status === "loaded"
      ? visibleCommitFiles(filesState.files)
      : null;

  const omittedFileCount = visibleFiles
    ? visibleFiles.testFilesOmitted + visibleFiles.overflowFilesOmitted
    : 0;

  return (
    <article
      className={
        expanded
          ? "whiteboard-commit-card whiteboard-commit-card--expanded"
          : "whiteboard-commit-card"
      }
    >
      <div className="whiteboard-commit-card-header">
        <button
          type="button"
          className="whiteboard-commit-toggle"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <DisclosureChevron expanded={expanded} />
          <span className="whiteboard-commit-copy">
            <strong title={commit.subject}>{commit.subject}</strong>
            <span>
              {commit.author} · {formatCommitTime(commit.authoredAt)}
            </span>
          </span>
          <span className="whiteboard-commit-stats">
            <span>{commit.fileCount} files</span>
            <DiffCount
              additions={commit.additions}
              deletions={commit.deletions}
            />
            <code>{commit.commit.slice(0, 8)}</code>
          </span>
        </button>
        <button
          type="button"
          className="whiteboard-commit-open"
          onClick={() => onOpenDiff(commit, "row")}
        >
          Open diff
        </button>
      </div>
      {expanded ? (
        <div className="whiteboard-commit-files">
          {filesState?.status === "loading" ? <p>Loading files…</p> : null}
          {filesState?.status === "error" ? <p>{filesState.error}</p> : null}
          {visibleFiles?.files.map((file) => (
            <button
              type="button"
              className="whiteboard-commit-file"
              key={file.path}
              onClick={() => {
                captureUiEvent(session, "commit_diff_opened", { via: "file" });
                openCommitDiff({ kind: "commit-diff", commit, file });
              }}
            >
              <FileMark status={file.status} />
              <span className="whiteboard-commit-file-path">{file.path}</span>
              <DiffCount
                additions={file.additions}
                deletions={file.deletions}
              />
            </button>
          ))}
          {omittedFileCount > 0 ? (
            <div className="whiteboard-commit-files-footer">
              +{omittedFileCount} more{" "}
              {omittedFileCount === 1 ? "file" : "files"}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export interface VisibleCommitFiles {
  files: WhiteboardDiffFileWire[];
  testFilesOmitted: number;
  overflowFilesOmitted: number;
}

export function visibleCommitFiles(
  files: readonly WhiteboardDiffFileWire[],
): VisibleCommitFiles {
  const visible = files.filter((file) => !isTestFile(file.path));
  visible.sort(
    (left, right) =>
      right.additions + right.deletions - (left.additions + left.deletions) ||
      left.path.localeCompare(right.path),
  );

  return {
    files: visible.slice(0, 8),
    testFilesOmitted: files.length - visible.length,
    overflowFilesOmitted: Math.max(0, visible.length - 8),
  };
}

function isTestFile(path: string): boolean {
  return (
    path.includes("/__tests__/") ||
    /(^|\/)__tests__\//u.test(path) ||
    /\.(test|spec)\.[^/]+$/u.test(path)
  );
}

export function groupCommitsByDate(
  commits: readonly WhiteboardCommitSummary[],
) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const groups: Array<{
    key: string;
    label: string;
    commits: WhiteboardCommitSummary[];
  }> = [];

  const orderedCommits = [...commits].sort(
    (left, right) => Date.parse(right.authoredAt) - Date.parse(left.authoredAt),
  );

  for (const commit of orderedCommits) {
    const date = new Date(commit.authoredAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const previous = groups.at(-1);

    if (previous?.key === key) {
      previous.commits.push(commit);
    } else {
      groups.push({
        key,
        label: formatter.format(date).toUpperCase(),
        commits: [commit],
      });
    }
  }

  return groups;
}

function formatCommitTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
