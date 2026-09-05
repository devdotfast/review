import { type ReactElement, useEffect, useRef, useState } from "react";

import { CopyIcon, copyText } from "./copy-text";

export function CopyCommandButton({
  command,
}: {
  command: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copyCommand = () => {
    void copyText(command).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      className="review-home-prompt-copy"
      aria-live="polite"
      aria-label={copied ? "Command copied" : "Copy command"}
      onClick={copyCommand}
    >
      <CopyIcon />
    </button>
  );
}
