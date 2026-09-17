import { createContext, useContext } from "react";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import type { SectionBlock } from "../../src/review-api/blocks/section";

import "./authoring-activity.css";

export const AuthoringActivityContext = createContext<
  ActivitySnapshot | "unknown" | undefined
>(undefined);

export function AuthoringActivityBadge({ targetId }: { targetId?: string }) {
  const activity = useContext(AuthoringActivityContext);

  if (!activity || (activity !== "unknown" && !activity.workingCount))
    return null;
  const working = activity !== "unknown";

  const focuses = working
    ? (activity.focuses ?? []).filter(
        (focus) => !targetId || focus.targetId === targetId,
      )
    : [];

  if (targetId && !focuses.length) return null;

  const description = [
    ...new Set(focuses.map((focus) => focus.description)),
  ].join(" · ");

  return (
    <span
      className={`host-authoring-activity${targetId ? " host-authoring-activity-inline" : ""}`}
      data-targeted={Boolean(targetId) || undefined}
      data-active={working || undefined}
      role="status"
      aria-live="polite"
      title={
        working
          ? description ||
            "An agent has reported ongoing authoring work. This signal expires if updates stop."
          : "Activity updates stopped. This does not mean the agent finished."
      }
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
