import { type ReactElement, useRef, useState } from "react";

import { useTutorial } from "./tutorial-context";
import { useTooltip } from "./use-tooltip";
import { useTopbarPopover } from "./use-topbar-popover";
import { useWhiteboardActions, useWhiteboardState } from "./whiteboard-context";

export function WhiteboardCornerAction(): ReactElement | null {
  const { dismissWhiteboard } = useWhiteboardActions();
  const { submissionOutcome } = useWhiteboardState();
  const tutorial = useTutorial();

  const closeTooltip = useTooltip("Close tutorial");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const errorPopover = useTopbarPopover<HTMLSpanElement>(failed, control);

  // A finished review has nothing left to submit or dismiss.
  if (submissionOutcome === "dismissed") return null;

  /* The tutorial is not in the review store, so there is no list to leave and
     nothing to reap. Closing the tab is the whole action, and it needs no
     confirmation. */
  if (tutorial) {
    return (
      <div className="whiteboard-corner-action">
        <button
          type="button"
          className="whiteboard-corner-dismiss"
          ref={closeTooltip}
          onClick={tutorial.close}
        >
          <ArchiveIcon />
          <span>Close</span>
        </button>
      </div>
    );
  }

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);

    try {
      await dismissWhiteboard();
    } catch (error) {
      console.error("Review action failed", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={control} className="whiteboard-corner-action">
      <button
        type="button"
        className="whiteboard-corner-dismiss"
        disabled={busy}
        onClick={() => void dismiss()}
      >
        <ArchiveIcon />
        <span>Dismiss</span>
      </button>
      {failed && (
        <span
          ref={errorPopover}
          popover="manual"
          className="whiteboard-corner-error"
          role="alert"
        >
          Could not dismiss the review. Try again.
        </span>
      )}
    </div>
  );
}

export function ArchiveIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="1.6" y="2.6" width="12.8" height="3.4" rx="1" />
      <path d="M3 6v6.2a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 12.2V6" />
      <path d="M6.4 9h3.2" />
    </svg>
  );
}
