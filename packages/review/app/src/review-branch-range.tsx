import { type ReactElement, useEffect, useRef, useState } from "react";

import { copyText } from "./copy-text";
import { useTooltip } from "./use-tooltip";

/** The two pinned commits, each shown by its branch name when the review
 * knows it and by its short hash otherwise. A click copies what is shown, in
 * full: the branch name, or the whole hash. */
export function ReviewBranchRange({
  baseRef,
  headRef,
  baseBranch,
  headBranch,
}: {
  baseRef: string;
  headRef: string;
  baseBranch?: string;
  headBranch?: string;
}): ReactElement {
  const [copied, setCopied] = useState<"base" | "head" | null>(null);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async (side: "base" | "head", text: string) => {
    if (!(await copyText(text))) return;
    clearTimeout(resetTimer.current);
    setCopied(side);
    resetTimer.current = setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="review-branch-range" aria-label="Review commits">
      <BranchRef
        label="base"
        commit={baseRef}
        branch={baseBranch}
        copied={copied === "base"}
        onCopy={(text) => void copy("base", text)}
      />
      <span className="review-branch-arrow" aria-hidden="true">
        →
      </span>
      <BranchRef
        label="head"
        commit={headRef}
        branch={headBranch}
        copied={copied === "head"}
        onCopy={(text) => void copy("head", text)}
      />
    </div>
  );
}

function BranchRef({
  label,
  commit,
  branch,
  copied,
  onCopy,
}: {
  label: "base" | "head";
  commit: string;
  branch?: string;
  copied: boolean;
  onCopy: (text: string) => void;
}): ReactElement {
  const name = branch?.trim() || undefined;
  const tooltip = useTooltip(name ? "Copy branch name" : "Copy commit hash");

  const displayName =
    name ??
    (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)
      ? commit.slice(0, 8)
      : commit);

  return (
    <span className="review-branch-ref">
      <span className="review-branch-label">{label}</span>
      <button
        type="button"
        className="review-branch-copy"
        data-copied={copied || undefined}
        aria-label={
          name
            ? `Copy ${label} branch name ${name}`
            : `Copy ${label} commit hash ${commit}`
        }
        ref={tooltip}
        onClick={() => onCopy(name ?? commit)}
      >
        <span className="review-branch-name">{displayName}</span>
        <span className="review-branch-feedback" role="status">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </span>
  );
}
