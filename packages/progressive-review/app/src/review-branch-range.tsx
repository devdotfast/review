import {
  type JsonValue,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";
import { type ReactElement, useEffect, useState } from "react";

import { CopyIcon, copyText } from "./copy-text";
import { useReviewSession } from "./host/review-session";

interface BranchLinks {
  baseUrl?: string;
  headUrl?: string;
}

export function ReviewBranchRange({
  baseRef,
  headRef,
}: {
  baseRef: string;
  headRef: string;
}): ReactElement {
  const session = useReviewSession();
  const [links, setLinks] = useState<BranchLinks>({});
  const [copied, setCopied] = useState<"base" | "head" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    session
      .fetch(
        `/branch-links?baseRef=${encodeURIComponent(baseRef)}&headRef=${encodeURIComponent(headRef)}`,
        { signal: controller.signal },
      )
      .then(async (response) => {
        const json: JsonValue = await response.json();
        if (!response.ok || !isJsonObject(json) || json.ok !== true) return;
        setLinks({
          baseUrl: jsonString(json.baseUrl),
          headUrl: jsonString(json.headUrl),
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [baseRef, headRef, session]);

  const copy = async (side: "base" | "head", ref: string) => {
    if (!(await copyText(ref))) return;
    setCopied(side);
    window.setTimeout(
      () => setCopied((value) => (value === side ? null : value)),
      1500,
    );
  };

  return (
    <div className="review-branch-range" aria-label="Review branches">
      <BranchRef label="base" name={baseRef} url={links.baseUrl} />
      <button
        type="button"
        className="review-branch-copy"
        aria-label={`Copy base branch ${baseRef}`}
        title={copied === "base" ? "Copied" : "Copy base branch"}
        onClick={() => void copy("base", baseRef)}
      >
        <CopyIcon />
      </button>
      <span className="review-branch-arrow" aria-hidden="true">
        ←
      </span>
      <BranchRef label="head" name={headRef} url={links.headUrl} />
      <button
        type="button"
        className="review-branch-copy"
        aria-label={`Copy head branch ${headRef}`}
        title={copied === "head" ? "Copied" : "Copy head branch"}
        onClick={() => void copy("head", headRef)}
      >
        <CopyIcon />
      </button>
    </div>
  );
}

function BranchRef({
  label,
  name,
  url,
}: {
  label: "base" | "head";
  name: string;
  url?: string;
}): ReactElement {
  const content = (
    <>
      <span className="review-branch-label">{label}:</span>
      <span className="review-branch-name">{name}</span>
    </>
  );
  return url ? (
    <a
      className="review-branch-ref review-branch-ref--linked"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${label} branch on GitHub`}
    >
      {content}
    </a>
  ) : (
    <span className="review-branch-ref">{content}</span>
  );
}
