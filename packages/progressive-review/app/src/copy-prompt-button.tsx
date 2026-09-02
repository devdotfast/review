import { useEffect, useRef, useState } from "react";

import { CopyIcon, copyText } from "./copy-text";

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
