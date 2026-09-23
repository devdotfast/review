import { useEffect, useRef, useState } from "react";

import { CopyIcon, copyText } from "./copy-text";

/** What the review covers. This is the only choice the reader makes. */
export type PromptKind = "change" | "architecture";

export const REVIEW_HOME_PROMPT_KIND_STORAGE_KEY =
  "dev.fast.review.homePromptKind";

const PROMPT_KINDS: ReadonlyArray<{ kind: PromptKind; label: string }> = [
  { kind: "change", label: "Review a change" },
  { kind: "architecture", label: "Architecture review" },
];

/**
 * Prompts name the subject and stop there: Whiteboard's server gives the agent
 * the authoring instructions, so every agent gets the same wording.
 */
export const PROMPTS: Record<PromptKind, string> = {
  change:
    "Create a Whiteboard of my current branch against up to date main, then open it in Whiteboard.",
  architecture:
    "Create a Whiteboard that sketches out the main data flows, access patterns, and code paths in this repo, so I can do a full architecture review of it. Open it in Whiteboard when you're done.",
};

const COPIED_RESET_MS = 2000;

/**
 * The copy-a-prompt card. Only the user's agent can write a review of their
 * own repo, so both the Welcome rail and the Home zero state end here.
 *
 * The tabs choose what the review covers.
 */
export function PromptCard() {
  const [kind, setKind] = useState<PromptKind>(readStoredPromptKind);
  const [copied, setCopied] = useState(false);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const selectKind = (next: PromptKind) => {
    setKind(next);
    setCopied(false);
    clearTimeout(resetTimer.current);

    try {
      globalThis.localStorage?.setItem(
        REVIEW_HOME_PROMPT_KIND_STORAGE_KEY,
        next,
      );
    } catch {
      // The desktop can disable DOM storage; the in-memory selection still works.
    }
  };

  const copyPrompt = () => {
    void copyText(PROMPTS[kind]).then((ok) => {
      if (!ok) {
        return;
      }

      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
    <section className="review-home-prompt-card" aria-label="Whiteboard prompt">
      <div
        className="review-home-prompt-tabs"
        role="group"
        aria-label="What to review"
      >
        {PROMPT_KINDS.map(({ kind: tab, label }) => (
          <button
            key={tab}
            type="button"
            className={kind === tab ? "is-active" : undefined}
            aria-pressed={kind === tab}
            onClick={() => selectKind(tab)}
          >
            {label}
          </button>
        ))}
      </div>
      <pre className="review-home-prompt-body">{PROMPTS[kind]}</pre>
      <div className="review-home-prompt-actions">
        <button
          type="button"
          className="review-home-prompt-copy"
          aria-live="polite"
          aria-label={copied ? "Prompt copied" : "Copy prompt"}
          onClick={copyPrompt}
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
    </section>
  );
}

function readStoredPromptKind(): PromptKind {
  try {
    const stored = globalThis.localStorage?.getItem(
      REVIEW_HOME_PROMPT_KIND_STORAGE_KEY,
    );

    if (stored === "change" || stored === "architecture") {
      return stored;
    }
  } catch {
    // Fall through to the default when DOM storage is unavailable.
  }

  return "change";
}
