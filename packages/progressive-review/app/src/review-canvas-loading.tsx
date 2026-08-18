import type { ReactElement, ReactNode } from "react";

interface ReviewCanvasLoadingProps {
  /** Optional status line under the spinner. Omit for a bare spinner. */
  message?: string;
  /** Optional note revealed after ~10s for loads that are taking too long. */
  note?: ReactNode;
  /** Fill the whole canvas rather than sitting inline in the document. */
  page?: boolean;
}

/**
 * The app's one loading affordance: spinner, polite live region, reduced-motion
 * handling, and a note that reveals itself only if the wait drags on.
 */
export function ReviewCanvasLoading({
  message,
  note,
  page = false,
}: ReviewCanvasLoadingProps): ReactElement {
  return (
    <div
      className={
        page
          ? "review-canvas-loading review-canvas-loading--page"
          : "review-canvas-loading"
      }
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="review-canvas-loading__spinner" aria-hidden="true" />
      {message ? (
        <p className="review-canvas-loading__message">{message}</p>
      ) : null}
      {note ? (
        <p className="review-canvas-loading__debug-note">{note}</p>
      ) : null}
    </div>
  );
}
