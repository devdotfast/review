import {
  type ReviewCommitSummary,
  type ReviewDiffFileWire,
  parseReviewDiffFilesResponse,
} from "@dev.fast/review-protocol";
import { useMemo, useState } from "react";

import { useReviewSession } from "./host/review-session";
import { useReviewPanel } from "./review-panel";
import { captureUiEvent } from "./ui-telemetry";

type CommitFilesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; files: ReviewDiffFileWire[] };

export function ReviewCommitsView({
  commits,
  range,
  onOpenDiff,
}: {
  commits: readonly ReviewCommitSummary[];
  range: import("@dev.fast/review-protocol").ReviewCanvasRange;
  onOpenDiff: (commit: ReviewCommitSummary, via: "row") => void;
}) {
  return (
    <div className="review-commits-view">
      <div className="review-commits-column">
        <header className="review-commits-range">
          <div>
            <strong>{commits.length} commits</strong>
            <span>
              {range.baseRef}..{range.headRef}
            </span>
          </div>
          <div className="review-commits-range-shas">
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
  commits: readonly ReviewCommitSummary[];
  onOpenDiff: (commit: ReviewCommitSummary, via: "row") => void;
}) {
  const groups = useMemo(() => groupCommitsByDate(commits), [commits]);
  return groups.map((group) => (
    <section className="review-commit-group" key={group.key}>
      <div className="review-commit-date">
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="3" />
        </svg>
        <h2>Commits on {group.label}</h2>
      </div>
      <div className="review-commit-timeline">
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
  commit: ReviewCommitSummary;
  onOpenDiff: (commit: ReviewCommitSummary, via: "row") => void;
}) {
  const session = useReviewSession();
  const openCommitDiff = useReviewPanel((panel) => panel.openCommitDiff);
  const [expanded, setExpanded] = useState(false);
  const [filesState, setFilesState] = useState<CommitFilesState | null>(null);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    captureUiEvent(session, "commit_expanded", { expanded: next });
    if (!next || filesState) return;
    setFilesState({ status: "loading" });
    const diffView = session.bridge.diffView;
    const request = diffView.files
      ? diffView.files({ commit: commit.commit }).then((files) => [...files])
      : session
          .fetch("/diff-files", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              includePatch: true,
              commit: commit.commit,
            }),
          })
          .then(async (response) => {
            const result = parseReviewDiffFilesResponse(await response.json());
            if (!response.ok || !result.ok) {
              throw new Error(
                result.ok ? "Unable to load commit files." : result.error,
              );
            }
            return result.files;
          });
    request
      .then((files) => setFilesState({ status: "loaded", files }))
      .catch((error: unknown) => {
        setFilesState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const shaped =
    filesState?.status === "loaded" ? shapeCommitFiles(filesState.files) : null;
  const omittedFileCount = shaped
    ? shaped.testFilesOmitted + shaped.overflowFilesOmitted
    : 0;
  return (
    <article
      className={
        expanded
          ? "review-commit-card review-commit-card--expanded"
          : "review-commit-card"
      }
    >
      <div className="review-commit-card-header">
        <button
          type="button"
          className="review-commit-toggle"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <span className="review-commit-chevron" aria-hidden="true">
            {expanded ? "⌄" : "›"}
          </span>
          <span className="review-commit-copy">
            <strong title={commit.subject}>{commit.subject}</strong>
            <span>
              {commit.author} · {formatCommitTime(commit.authoredAt)}
            </span>
          </span>
          <span className="review-commit-stats">
            <span>{commit.fileCount} files</span>
            <span className="review-additions">+{commit.additions}</span>
            <span className="review-deletions">−{commit.deletions}</span>
            <code>{commit.commit.slice(0, 8)}</code>
          </span>
        </button>
        <button
          type="button"
          className="review-commit-open"
          onClick={() => onOpenDiff(commit, "row")}
        >
          Open diff ↗
        </button>
      </div>
      {expanded ? (
        <div className="review-commit-files">
          {filesState?.status === "loading" ? <p>Loading files…</p> : null}
          {filesState?.status === "error" ? <p>{filesState.error}</p> : null}
          {shaped?.files.map((file) => (
            <button
              type="button"
              className="review-commit-file"
              key={file.path}
              onClick={() => {
                captureUiEvent(session, "commit_diff_opened", { via: "file" });
                openCommitDiff(commit, file);
              }}
            >
              <span className="review-commit-file-path">{file.path}</span>
              <span className="review-commit-file-stats">
                <span className="review-additions">+{file.additions}</span>
                <span className="review-deletions">−{file.deletions}</span>
              </span>
            </button>
          ))}
          {omittedFileCount > 0 ? (
            <div className="review-commit-files-footer">
              +{omittedFileCount} more{" "}
              {omittedFileCount === 1 ? "file" : "files"}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function shapeCommitFiles(files: readonly ReviewDiffFileWire[]): {
  files: ReviewDiffFileWire[];
  testFilesOmitted: number;
  overflowFilesOmitted: number;
} {
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

export function groupCommitsByDate(commits: readonly ReviewCommitSummary[]) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const groups: Array<{
    key: string;
    label: string;
    commits: ReviewCommitSummary[];
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
