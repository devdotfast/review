import type { ReviewDiffFileWire } from "@dev.fast/review-protocol";
import type { ReactElement } from "react";

const MARK_PATHS: Record<ReviewDiffFileWire["status"], ReactElement> = {
  added: <path d="M8 4v8M4 8h8" />,
  deleted: <path d="M4 8h8" />,
  modified: <circle cx="8" cy="8" r="2.75" />,
  renamed: <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />,
  unchanged: <path d="M4.5 2.5h4.5l3 3v8h-7.5z M9 2.5v3h3" />,
};

/**
 * A file's status as one stroke beside its name: plus, minus, dot, arrow, or
 * a ghost file outline for referenced context. Same 16px slot as the chevron;
 * the workbench draws the same paths for its tree and diff headers.
 */
export function FileMark({
  status,
}: {
  status: ReviewDiffFileWire["status"];
}): ReactElement {
  return (
    <svg
      className={`review-file-mark review-file-mark-${status}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {MARK_PATHS[status]}
    </svg>
  );
}
