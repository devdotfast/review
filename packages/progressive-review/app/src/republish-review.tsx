import { type ReactElement, useEffect, useRef, useState } from "react";

import { CopyPromptButton } from "./copy-prompt-button";
import { CopyIcon, copyText } from "./copy-text";

export function repairReviewPrompt({
  reviewUuid,
  mapStale,
}: {
  reviewUuid: string;
  mapStale: boolean;
}): string {
  const prompt = `Repair the currently presented Review with id \`${reviewUuid}\`. Run \`review repair --review ${reviewUuid} --json\`. If it reports validation errors, fix only the reported authoring inputs without changing what the current review says, then rerun. Reconcile any unpublished authoring edits before using source-based repair. Preserve the review status, pinned commits, and threads; do not republish or repair older historical revisions.`;
  return mapStale
    ? `${prompt} The published software map also needs repair.`
    : prompt;
}

export function RepairReview(props: {
  reviewUuid: string;
  mapStale: boolean;
}): ReactElement {
  const command = `review repair --review ${props.reviewUuid}`;
  return (
    <section className="review-republish" role="status">
      <h2>Repair this review</h2>
      <p>
        This review's published artifacts must be regenerated. Repair keeps its
        review status, pinned commits, and threads.
      </p>
      {props.mapStale ? (
        <p>The published software map also needs repair.</p>
      ) : null}
      <div className="review-republish-command">
        <code>{command}</code>
        <CopyCommandButton command={command} />
        <CopyPromptButton prompt={repairReviewPrompt(props)} />
      </div>
    </section>
  );
}

function CopyCommandButton({ command }: { command: string }): ReactElement {
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
