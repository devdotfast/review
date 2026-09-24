import { createContext, useContext, useState } from "react";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import { scopeLive } from "./authoring-cursor";
import {
  AuthoringCursorContext,
  LensCursorContext,
  lensRowElement,
} from "./courier";
import { CourierFigure } from "./courier-figure";
import { cursorElement } from "./cursor-element";
import { DisplayedReviewVersionContext } from "./displayed-review-version-context";
import { useReviewRoots } from "./review-root-context";
import { useTooltip } from "./use-tooltip";

import "./authoring-activity.css";

export const AuthoringActivityContext = createContext<
  ActivitySnapshot | "unknown" | undefined
>(undefined);

/**
 * The top-bar badge: the mini courier and what the agent is doing. While an
 * agent works, clicking it opens the Review surface; when the courier is on
 * the board, it also takes the reader to him, and he jumps so the eye finds
 * him. When only lenses are being written, or only the lenses' courier is
 * out, it opens the Diffs page and finds the courier in the lens list.
 */
export function AuthoringActivityBadge({
  onLocate,
}: {
  /** Show the surface (before scrolling to its courier, if any). */
  onLocate?(view: "review" | "diff"): void;
}) {
  const activity = useContext(AuthoringActivityContext);
  const documentCursor = useContext(AuthoringCursorContext);
  const lensCursor = useContext(LensCursorContext);
  const roots = useReviewRoots();

  const working = activity && activity !== "unknown";

  const toLenses =
    (scopeLive(activity, "lenses") && !scopeLive(activity, "document")) ||
    (!documentCursor && !!lensCursor);

  const cursor = toLenses ? lensCursor : documentCursor;

  const focuses = working ? (activity.focuses ?? []) : [];

  const description = [
    ...new Set(focuses.map((focus) => focus.description)),
  ].join(" · ");

  const tooltip = useTooltip<HTMLElement>(
    working
      ? `${description || "An agent has reported ongoing authoring work. This signal expires if updates stop."}${cursor ? " · Click to go to the courier." : ""}`
      : "Activity updates stopped. This does not mean the agent finished.",
  );

  const locate = () => {
    onLocate?.(toLenses ? "diff" : "review");

    if (!cursor) return;

    // The surface may only be showing now; measure after it paints.
    requestAnimationFrame(() => {
      const container = toLenses
        ? roots?.appRef.current?.querySelector<HTMLElement>(
            ".diff-sidebar-lenses",
          )
        : roots?.articleRef.current;

      if (!container) return;

      const target = (toLenses ? lensRowElement : cursorElement)(
        container,
        cursor,
      );

      if (!target) return;
      target.scrollIntoView?.({ block: "center", behavior: "smooth" });
      container
        .querySelector<HTMLButtonElement>(
          `.courier[data-scope="${toLenses ? "lenses" : "document"}"] .courier-figure`,
        )
        ?.click();
    });
  };

  if (!activity || (working && !activity.workingCount)) return null;

  const text = working
    ? description ||
      (activity.workingCount > 1
        ? `${activity.workingCount} agents working…`
        : "Agent working…")
    : "Activity unknown";

  const className = "host-authoring-activity";

  if (!working)
    return (
      <span
        className={className}
        role="status"
        aria-live="polite"
        ref={tooltip}
      >
        <CourierFigure className="host-authoring-courier" />
        <span className="host-authoring-text">{text}</span>
      </span>
    );

  return (
    <button
      type="button"
      className={className}
      data-active
      data-locatable
      aria-label={cursor ? `${text}. Go to the courier.` : undefined}
      ref={tooltip}
      onClick={locate}
    >
      <CourierFigure className="host-authoring-courier" />
      <span className="host-authoring-text" role="status" aria-live="polite">
        {text}
      </span>
    </button>
  );
}

/**
 * The word "Whiteboard" in the top bar's surface tabs. While an agent is writing,
 * marker ink sweeps through the word. The document is ready once it has
 * content and no authoring session is live, so ending (or losing) the lease is
 * what finishes it. When it becomes ready while the reader is on another
 * surface, an unread dot sits just past the word until they visit the tab, and
 * it comes back only when a later version arrives while they are elsewhere
 * again. A document that is already ready when this mounts counts as read.
 * Neither state changes the tab's layout box.
 */
export function ReviewSurfaceLabel({
  hasContent,
  active,
  label = "Whiteboard",
}: {
  hasContent: boolean;
  active: boolean;
  /** The tab's word; the scratchpad names itself. */
  label?: string;
}) {
  const activity = useContext(AuthoringActivityContext);
  const version = useContext(DisplayedReviewVersionContext) ?? null;

  // Any live lease, document or lenses, means the review is not ready yet.
  const live =
    activity !== undefined &&
    activity !== "unknown" &&
    activity.workingCount > 0;

  const ready = hasContent && !live;

  const [readVersion, setReadVersion] = useState<number | null>(() =>
    active || ready ? version : null,
  );

  if (active && readVersion !== version) setReadVersion(version);
  const unread = !active && ready && readVersion !== version;

  return (
    <span className="review-segment-word" data-working={live || undefined}>
      {label}
      {unread && <span className="review-segment-unread" aria-hidden="true" />}
    </span>
  );
}
