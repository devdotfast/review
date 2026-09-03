import { type ReactElement, useEffect, useRef, useState } from "react";

import { useReviewActions, useReviewState } from "./review-context";
import { useTutorial } from "./tutorial-context";

/**
 * The single end-of-review control in the topbar. It never shows two actions at
 * once: with pending comments it submits them, otherwise it dismisses.
 *
 * Dismissal confirms once. Closing the review tab does nothing to the review,
 * so the confirmation is the only place that names the difference.
 */
export function ReviewCornerAction(): ReactElement | null {
  const { submitPendingComments, dismissReview } = useReviewActions();
  const { pendingCommentCount, submissionOutcome } = useReviewState();
  const tutorial = useTutorial();
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const pending = pendingCommentCount;

  useEffect(() => {
    if (!confirming) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        controlRef.current?.contains(event.target)
      ) {
        return;
      }
      setConfirming(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirming(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [confirming]);

  // A finished review has nothing left to submit or dismiss.
  if (submissionOutcome === "dismissed") return null;

  /* The tutorial is not in the review store, so there is no list to leave and
     nothing to reap. Closing the tab is the whole action, and it needs no
     confirmation. */
  if (tutorial) {
    return (
      <div className="review-corner-action">
        <button
          type="button"
          className="review-corner-dismiss"
          onClick={tutorial.close}
        >
          <ArchiveIcon />
          <span>Close</span>
        </button>
      </div>
    );
  }

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await action();
      setConfirming(false);
    } catch (error) {
      console.error("Review action failed", error);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (pending > 0) {
    return (
      <div ref={controlRef} className="review-corner-action">
        <button
          type="button"
          className="review-corner-submit"
          disabled={busy}
          onClick={() =>
            void run(() => submitPendingComments("request-changes"))
          }
        >
          <SendIcon />
          <span>Submit review</span>
          <strong>{pending}</strong>
        </button>
        {failed ? (
          <span className="review-corner-error" role="alert">
            Could not submit. Your comments are still pending.
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={controlRef} className="review-corner-action">
      <button
        type="button"
        className="review-corner-dismiss"
        aria-haspopup="dialog"
        aria-expanded={confirming}
        disabled={busy}
        onClick={() => setConfirming((open) => !open)}
      >
        <ArchiveIcon />
        <span>Dismiss</span>
      </button>
      {confirming && (
        <div
          className="review-corner-confirm"
          role="dialog"
          aria-label="Dismiss this review"
        >
          <strong>Dismiss this review?</strong>
          <p>
            It leaves your active list and deletes itself later. Closing the tab
            does neither. You can undo this from Home.
          </p>
          {failed ? (
            <span className="review-corner-error" role="alert">
              Could not dismiss the review.
            </span>
          ) : null}
          <div className="review-corner-confirm-actions">
            <button
              type="button"
              className="review-corner-confirm-yes"
              disabled={busy}
              onClick={() => void run(() => dismissReview())}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="review-corner-confirm-no"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SendIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M2.2 8.1 13.6 2.7 9.3 13.9 7.6 9.3 2.2 8.1Z" />
    </svg>
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
