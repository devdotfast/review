import type { ReviewCliInstallStatus } from "@dev.fast/review-protocol";
import { useEffect, useRef, useState } from "react";

/** Which agent's invocation syntax the prompt uses. Derived, never asked. */
export type PromptAgent = "claude" | "codex" | "generic";

/** What the review covers. This is the only choice the reader makes. */
export type PromptKind = "change" | "architecture";

export const REVIEW_HOME_PROMPT_KIND_STORAGE_KEY =
  "dev.fast.review.homePromptKind";

const PROMPT_KINDS: ReadonlyArray<{ kind: PromptKind; label: string }> = [
  { kind: "change", label: "Review a change" },
  { kind: "architecture", label: "Architecture review" },
];

/**
 * The architecture prompt names the mode and stops there: the dev-review skill
 * documents how to scaffold one (same commit as base and head, system-shaped
 * sections), so the prompt does not have to carry the mechanics.
 */
export const PROMPT_VARIANTS: Record<
  PromptKind,
  Record<PromptAgent, string>
> = {
  change: {
    claude:
      "Use the dev-review skill to review my current branch against up to date main, then open it in Review.",
    codex:
      "Use $dev-review to review my current branch against up to date main, then open it in Review.",
    generic:
      "Use the `review` CLI to review my current branch against up to date main: run `review scaffold`, write the review, then `review publish`.",
  },
  architecture: {
    claude:
      "Use the dev-review skill to sketch out the main data flows, access patterns, and code paths in this repo, so I can do a full architecture review of it. Open it in Review when you're done.",
    codex:
      "Use $dev-review to sketch out the main data flows, access patterns, and code paths in this repo, so I can do a full architecture review of it. Open it in Review when you're done.",
    generic:
      "Use the `review` CLI to sketch out the main data flows, access patterns, and code paths in this repo, so I can do a full architecture review of it: run `review scaffold` with the same commit as base and head, write the review, then `review publish`.",
  },
};

const COPIED_RESET_MS = 2000;

/**
 * The copy-a-prompt card. Only the user's agent can write a review of their
 * own repo, so both the Welcome rail and the Home zero state end here.
 *
 * The tabs choose what the review covers. Which agent it is written for is
 * passed in, not asked: the app already knows what is installed.
 */
export function PromptCard({ agent }: { agent: PromptAgent }) {
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
    void copyText(PROMPT_VARIANTS[kind][agent]).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
    <section className="review-home-prompt-card" aria-label="Review prompt">
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
      <pre className="review-home-prompt-body">
        {PROMPT_VARIANTS[kind][agent]}
      </pre>
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

/**
 * Which agent's syntax to write the prompt in. A choice saved from the
 * removed Home agent tabs still wins while that agent is around: the tabs
 * are gone, but the preference they stored is not, and the derived order
 * cannot know which of two installed agents the reader actually uses.
 * Otherwise an installed agent wins over a merely detected one; Cursor has
 * no skill invocation of its own, so it falls through to the CLI wording.
 */
export function promptAgent(
  status: ReviewCliInstallStatus | undefined,
): PromptAgent {
  if (!status) return "generic";
  const has = (target: "claude" | "codex", key: "installed" | "present") =>
    status.agents.some((agent) => agent.target === target && agent[key]);
  const stored = readStoredPromptAgent();
  if (stored === "generic") return "generic";
  if (stored && (has(stored, "installed") || has(stored, "present"))) {
    return stored;
  }
  for (const key of ["installed", "present"] as const) {
    if (has("claude", key)) return "claude";
    if (has("codex", key)) return "codex";
  }
  return "generic";
}

/** Written by the Home agent tabs that #891 removed; never written today. */
const LEGACY_PROMPT_AGENT_STORAGE_KEY = "dev.fast.review.homePromptAgent";

function readStoredPromptAgent(): PromptAgent | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(
      LEGACY_PROMPT_AGENT_STORAGE_KEY,
    );
    if (stored === "claude" || stored === "codex" || stored === "generic") {
      return stored;
    }
  } catch {
    // Fall through to the derived choice when DOM storage is unavailable.
  }
  return undefined;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The workbench session denies DOM clipboard permission requests; fall
    // through to the selection-based copy, which Electron always allows.
  }
  const active = document.activeElement;
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // Leave ok false; the button simply stays on "Copy prompt".
  }
  scratch.remove();
  if (active instanceof HTMLElement) {
    active.focus();
  }
  return ok;
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

function CopyIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <path d="M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
    </svg>
  );
}
