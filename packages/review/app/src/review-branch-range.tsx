import { type ReactElement, useEffect, useRef, useState } from "react";

import { copyText } from "./copy-text";
import { useTooltip } from "./use-tooltip";

const fullHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** A branch name as is; a full commit hash cut to its first eight digits. */
export function shortRef(ref: string): string {
  return fullHash.test(ref) ? ref.slice(0, 8) : ref;
}

/** A head that is the checkout's working files, not a commit. */
export const WORKING_TREE = Symbol("working tree");

/**
 * The pinned commit range as two copyable chips, `base ← head`: the arrow
 * points from the head commit into the base it is compared against. A
 * working-tree head has no commit to copy, so it is a plain label.
 */
export function ReviewBranchRange({
  baseRef,
  headRef,
}: {
  baseRef: string;
  headRef: string | typeof WORKING_TREE;
}): ReactElement {
  const [copied, setCopied] = useState<"base" | "head" | null>(null);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async (side: "base" | "head", ref: string) => {
    if (!(await copyText(ref))) return;
    clearTimeout(resetTimer.current);
    setCopied(side);
    resetTimer.current = setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div
      className="review-branch-range"
      role="group"
      aria-label={`Session commits: base ${shortRef(baseRef)}, head ${
        headRef === WORKING_TREE ? "working tree" : shortRef(headRef)
      }`}
    >
      <BranchRef
        label="base"
        name={baseRef}
        copied={copied === "base"}
        onCopy={() => void copy("base", baseRef)}
      />
      <span className="review-branch-arrow" aria-hidden="true">
        ←
      </span>
      {headRef === WORKING_TREE ? (
        <WorkingTreeRef />
      ) : (
        <BranchRef
          label="head"
          name={headRef}
          copied={copied === "head"}
          onCopy={() => void copy("head", headRef)}
        />
      )}
    </div>
  );
}

function BranchRef({
  label,
  name,
  copied,
  onCopy,
}: {
  label: "base" | "head";
  name: string;
  copied: boolean;
  onCopy: () => void;
}): ReactElement {
  const tooltip = useTooltip(`${label} ${name}`, { detail: "Click to copy" });

  return (
    <button
      type="button"
      className="review-branch-copy"
      data-side={label}
      data-copied={copied || undefined}
      aria-label={`Copy ${label} commit hash ${name}`}
      ref={tooltip}
      onClick={onCopy}
    >
      <span className="review-branch-name">{shortRef(name)}</span>
      <span className="review-branch-feedback" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function WorkingTreeRef(): ReactElement {
  const tooltip = useTooltip<HTMLSpanElement>("head Working tree", {
    detail: "Saved files in the checkout, including uncommitted changes",
  });

  return (
    <span className="review-branch-worktree" data-side="head" ref={tooltip}>
      Working tree
    </span>
  );
}
