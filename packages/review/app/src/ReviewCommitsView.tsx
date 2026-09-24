import {
  type ReviewCommitSummary,
  type ReviewDiffFileWire,
} from "@dev.fast/review-protocol";
import { useMemo, useState } from "react";

import { CopyButton } from "./copy-text";
import { DiffCount } from "./diff-count";
import { FileMark } from "./file-mark";
import { useReviewSession } from "./host/review-session";
import { CodeIcon, DisclosureChevron } from "./icons";
import { shortRef } from "./review-branch-range";
import { ReviewUnavailable } from "./review-empty-state";
import { countLabel } from "./review-home-view";
import { captureUiEvent } from "./ui-telemetry";
import { useTooltip } from "./use-tooltip";

type OpenCommitDiff = (
  commit: ReviewCommitSummary,
  via: "row" | "file",
  file?: string,
) => void;

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
  onOpenDiff: OpenCommitDiff;
}) {
  if (range.sourceUnavailable) {
    return (
      <ReviewUnavailable
        role="status"
        title="Commits unavailable"
        message={range.sourceUnavailable}
      />
    );
  }

  return (
    <div className="review-commits-view">
      <div className="review-commits-column">
        <header className="review-commits-range">
          <strong>{countLabel(commits.length, "commit")}</strong>
          <span title={`${range.baseCommit}..${range.headCommit}`}>
            {shortRef(range.baseRef || range.baseCommit)} →{" "}
            {shortRef(range.headRef || range.headCommit)}
          </span>
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
  onOpenDiff: OpenCommitDiff;
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
  onOpenDiff: OpenCommitDiff;
}) {
  const session = useReviewSession();
  const [expanded, setExpanded] = useState(false);
  const [filesState, setFilesState] = useState<CommitFilesState | null>(null);
  const openTooltip = useTooltip("Open commit diff");

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
          title={commit.subject}
        >
          <DisclosureChevron expanded={expanded} />
          <strong>{commit.subject}</strong>
        </button>
        <span className="review-commit-actions">
          <span className="review-commit-sha">{commit.commit.slice(0, 8)}</span>
          <CopyButton
            text={commit.commit}
            label="Copy commit SHA"
            className="review-topbar-icon-button"
          />
          <button
            ref={openTooltip}
            type="button"
            className="review-topbar-icon-button review-commit-open"
            aria-label="Open commit diff"
            onClick={() => onOpenDiff(commit, "row")}
          >
            <CodeIcon />
          </button>
        </span>
        <span className="review-commit-meta">
          {commit.author} · {formatCommitTime(commit.authoredAt)} ·{" "}
          {countLabel(commit.fileCount, "file")}{" "}
          <DiffCount
            additions={commit.additions}
            deletions={commit.deletions}
          />
        </span>
      </div>
      {expanded ? (
        <div className="review-commit-files">
          {filesState?.status === "loading" ? <p>Loading files…</p> : null}
          {filesState?.status === "error" ? <p>{filesState.error}</p> : null}
          {visibleFiles?.files.map((file) => (
            <button
              type="button"
              className="review-commit-file"
              key={file.path}
              onClick={() => onOpenDiff(commit, "file", file.path)}
            >
              <FileMark status={file.status} />
              <span className="review-commit-file-path">{file.path}</span>
              <DiffCount
                additions={file.additions}
                deletions={file.deletions}
              />
            </button>
          ))}
          {omittedFileCount > 0 ? (
            <button
              type="button"
              className="review-commit-files-footer"
              onClick={() => onOpenDiff(commit, "row")}
            >
              {countLabel(omittedFileCount, "more file")}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export interface VisibleCommitFiles {
  files: ReviewDiffFileWire[];
  testFilesOmitted: number;
  overflowFilesOmitted: number;
}

export function visibleCommitFiles(
  files: readonly ReviewDiffFileWire[],
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
