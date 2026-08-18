import { useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 2000;

export function CopyPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copyPrompt = () => {
    void copyText(prompt).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
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
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The workbench session denies DOM clipboard permission requests. Use the
    // selection-based copy, which Electron allows.
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
    // Leave ok false. The button stays on "Copy prompt".
  }
  scratch.remove();
  if (active instanceof HTMLElement) active.focus();
  return ok;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <path d="M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
    </svg>
  );
}
