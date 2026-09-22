import { type ReactElement, useEffect, useRef, useState } from "react";

import { copyText } from "./copy-text";
import { useTooltip } from "./use-tooltip";

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
    <div className="review-branch-range" aria-label="Session commits">
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
  const tooltip = useTooltip("Copy commit hash");

  const displayName = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(name)
    ? name.slice(0, 8)
    : name;

  return (
    <span className="review-branch-ref">
      <span className="review-branch-label">{label}:</span>
      <button
        type="button"
        className="review-branch-copy"
        data-copied={copied || undefined}
        aria-label={`Copy ${label} commit hash ${name}`}
        ref={tooltip}
        onClick={onCopy}
      >
        <span className="review-branch-name">{displayName}</span>
        <span className="review-branch-feedback" role="status">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </span>
  );
}
