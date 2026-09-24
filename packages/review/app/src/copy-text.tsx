import { type ReactElement, useEffect, useState } from "react";

import { CheckIcon, CopyIcon as CopyGlyph } from "./icons";
import { useTooltip } from "./use-tooltip";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    // The workbench denies DOM clipboard permission requests.
  }

  const active = document.activeElement;
  const selection = document.getSelection();

  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  let copied = false;

  try {
    copied = document.execCommand("copy");
  } catch {
    // The caller keeps its default label when the copy fails.
  }

  scratch.remove();

  if (active instanceof HTMLElement) active.focus();

  if (selection && ranges.length) {
    selection.removeAllRanges();

    for (const range of ranges) selection.addRange(range);
  }

  return copied;
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <path d="M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

const COPIED_FOR_MS = 1200;

/** An icon button that copies `text` and shows a check while it is copied. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const tooltip = useTooltip(label);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      ref={tooltip}
      type="button"
      className={className}
      aria-label={label}
      data-copied={copied ? "" : undefined}
      onClick={() => {
        // The workbench denies DOM clipboard requests; copyText falls back to
        // execCommand and reports whether anything was copied.
        void copyText(text).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyGlyph />}
    </button>
  );
}
