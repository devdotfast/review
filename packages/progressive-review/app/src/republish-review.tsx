import { type ReactElement, useEffect, useRef, useState } from "react";

import { CopyPromptButton } from "./copy-prompt-button";
import { CopyIcon, copyText } from "./copy-text";

export function republishReviewPrompt({
  reviewUuid,
  mapStale,
}: {
  reviewUuid: string;
  mapStale: boolean;
}): string {
  const prompt = `Republish the Review with id \`${reviewUuid}\`. It was published by an earlier version of Review and its document must be regenerated. Run \`review publish --review ${reviewUuid} --json\`. If it reports validation errors, fix them in that Review's \`review.mdx\` or \`data.ts\` without changing what the review says, and rerun until it succeeds.`;
  return mapStale
    ? `${prompt} Then run \`review map publish --review ${reviewUuid} --json\`.`
    : prompt;
}

export function RepublishReview(props: {
  reviewUuid: string;
  mapStale: boolean;
}): ReactElement {
  const command = `review publish --review ${props.reviewUuid}`;
  const mapCommand = `review map publish --review ${props.reviewUuid}`;
  return (
    <section className="review-republish">
      <h2>Republish this review</h2>
      <p>
        This review was published by an earlier version of Review and its
        document must be regenerated.
      </p>
      <div className="review-republish-command">
        <code>{command}</code>
        <CopyCommandButton command={command} />
      </div>
      {props.mapStale ? (
        <div className="review-republish-command">
          <code>{mapCommand}</code>
          <CopyCommandButton command={mapCommand} />
        </div>
      ) : null}
      <div className="review-republish-actions">
        <CopyPromptButton prompt={republishReviewPrompt(props)} />
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
