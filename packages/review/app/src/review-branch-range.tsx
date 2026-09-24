import { type ReactElement, useEffect, useRef, useState } from "react";

import { copyText } from "./copy-text";
import { useTooltip } from "./use-tooltip";

const fullHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** A branch name as is; a full commit hash cut to its first eight digits. */
export function shortRef(ref: string): string {
  return fullHash.test(ref) ? ref.slice(0, 8) : ref;
}

/**
 * The pinned commit range as two copyable chips, `base ← head`: the arrow
 * points from the head commit into the base it is compared against.
 */
export function ReviewBranchRange({
  baseRef,
  headRef,
}: {
  baseRef: string;
  headRef: string;
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
      aria-label={`Session commits: base ${shortRef(baseRef)}, head ${shortRef(headRef)}`}
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
      <BranchRef
        label="head"
        name={headRef}
        copied={copied === "head"}
        onCopy={() => void copy("head", headRef)}
      />
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
