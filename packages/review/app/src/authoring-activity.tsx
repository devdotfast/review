import { createContext, useContext, useState } from "react";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import type { SectionBlock } from "../../src/review-api/blocks/section";
import { DisplayedReviewVersionContext } from "./review-history-control";
import { useTooltip } from "./use-tooltip";

import "./authoring-activity.css";

export const AuthoringActivityContext = createContext<
  ActivitySnapshot | "unknown" | undefined
>(undefined);

export function AuthoringActivityBadge({ targetId }: { targetId?: string }) {
  const activity = useContext(AuthoringActivityContext);

  const working = activity && activity !== "unknown";

  const focuses = working
    ? (activity.focuses ?? []).filter(
        (focus) => !targetId || focus.targetId === targetId,
      )
    : [];

  const description = [
    ...new Set(focuses.map((focus) => focus.description)),
  ].join(" · ");

  const tooltip = useTooltip<HTMLSpanElement>(
    working
      ? description ||
          "An agent has reported ongoing authoring work. This signal expires if updates stop."
      : "Activity updates stopped. This does not mean the agent finished.",
  );

  if (
    !activity ||
    (working && !activity.workingCount) ||
    (targetId && !focuses.length)
  )
    return null;

  return (
    <span
      className={`host-authoring-activity${targetId ? " host-authoring-activity-inline" : ""}`}
      data-targeted={Boolean(targetId) || undefined}
      data-active={working || undefined}
      role="status"
      aria-live="polite"
      ref={tooltip}
    >
      <span className="host-authoring-activity-dot" aria-hidden="true" />
      {working
        ? description ||
          (activity.workingCount > 1
            ? `${activity.workingCount} agents working…`
            : "Agent working…")
        : "Activity unknown"}
    </span>
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
}: {
  complete: boolean;
  active: boolean;
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
      Review
      {unread && <span className="review-segment-unread" aria-hidden="true" />}
    </span>
  );
}

export function SectionAuthoringProgress({
  targetId,
  status,
}: {
  targetId: string;
  status: SectionBlock["status"];
}) {
  const activity = useContext(AuthoringActivityContext);

  const descriptions =
    activity && activity !== "unknown"
      ? (activity.focuses ?? [])
          .filter((focus) => focus.targetId === targetId)
          .map((focus) => focus.description)
      : [];

  const unfinished = status === "pending" || status === "in_progress";

  if (status === "complete" || (!unfinished && !descriptions.length))
    return null;

  const progress =
    descriptions.length || status === "in_progress" ? "in_progress" : "pending";

  const description =
    [...new Set(descriptions)].join(" · ") ||
    (progress === "pending" ? "Pending" : "In progress");

  return (
    <div
      className="review-section-progress"
      data-state={progress}
      role="status"
      aria-label={description}
      title={description}
    />
  );
}
