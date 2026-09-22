import { createContext, useContext, useState } from "react";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import { AuthoringCursorContext } from "./courier";
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
 * The top-bar badge: the mini courier and what the agent is doing. Clicking
 * it takes the reader to the big courier, on the Review surface, and he
 * jumps so the eye finds him.
 */
export function AuthoringActivityBadge({
  onLocate,
}: {
  /** Show the Review surface before scrolling to the courier. */
  onLocate?(): void;
}) {
  const activity = useContext(AuthoringActivityContext);
  const cursor = useContext(AuthoringCursorContext);
  const roots = useReviewRoots();

  const working = activity && activity !== "unknown";

  const focuses = working ? (activity.focuses ?? []) : [];

  const description = [
    ...new Set(focuses.map((focus) => focus.description)),
  ].join(" · ");

  const locatable = Boolean(cursor && working);

  const tooltip = useTooltip<HTMLElement>(
    working
      ? `${description || "An agent has reported ongoing authoring work. This signal expires if updates stop."}${locatable ? " · Click to go to the courier." : ""}`
      : "Activity updates stopped. This does not mean the agent finished.",
  );

  const locate = () => {
    if (!locatable) return;
    onLocate?.();

    // The Review surface may only be mounting now; measure after it paints.
    requestAnimationFrame(() => {
      const article = roots?.articleRef.current;

      if (!article || !cursor) return;
      const target = cursorElement(article, cursor);

      if (!target) return;
      target.scrollIntoView?.({ block: "center", behavior: "smooth" });
      article.querySelector<HTMLButtonElement>(".courier-figure")?.click();
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

  if (!locatable)
    return (
      <span
        className={className}
        data-active={working || undefined}
        role="status"
        aria-live="polite"
        ref={tooltip}
      >
        <CourierFigure className="host-authoring-courier" />
        {text}
      </span>
    );

  return (
    <button
      type="button"
      className={className}
      data-active
      data-locatable
      aria-label={`${text}. Go to the courier.`}
      ref={tooltip}
      onClick={locate}
    >
      <CourierFigure className="host-authoring-courier" />
      <span role="status" aria-live="polite">
        {text}
      </span>
    </button>
  );
}

/**
 * The word "Review" in the top bar's surface tabs. While an agent is writing,
 * marker ink sweeps through the word; when the document becomes ready (agent
 * gone, every section complete) while the reader is on another surface, an
 * unread dot sits just past the word until they visit the tab, and it comes
 * back only when a later version arrives while they are elsewhere again. A
 * document that is already ready when this mounts counts as read. Neither
 * state changes the tab's layout box.
 */
export function ReviewSurfaceLabel({
  complete,
  active,
  label = "Review",
}: {
  complete: boolean;
  active: boolean;
  /** The tab's word; the scratchpad names itself. */
  label?: string;
}) {
  const activity = useContext(AuthoringActivityContext);
  const version = useContext(DisplayedReviewVersionContext) ?? null;

  const live =
    activity !== undefined &&
    activity !== "unknown" &&
    activity.workingCount > 0;

  const ready = complete && !live;

  const [readVersion, setReadVersion] = useState<number | null>(() =>
    active || ready ? version : null,
  );

  if (active && readVersion !== version) setReadVersion(version);
  const unread = !active && ready && readVersion !== version;

  return (
    <span
      className="review-segment-word"
      data-working={(live && !complete) || undefined}
    >
      {label}
      {unread && <span className="review-segment-unread" aria-hidden="true" />}
    </span>
  );
}
