import { createContext, useContext } from "react";

import type { ActivitySnapshot } from "../../src/review-api/activity";

import "./authoring-activity.css";

export const AuthoringActivityContext = createContext<
  ActivitySnapshot | "unknown" | undefined
>(undefined);

export function AuthoringActivityBadge() {
  const activity = useContext(AuthoringActivityContext);

  if (!activity || (activity !== "unknown" && !activity.workingCount))
    return null;
  const working = activity !== "unknown";

  return (
    <span
      className="host-authoring-activity"
      data-active={working || undefined}
      role="status"
      aria-live="polite"
      title={
        working
          ? "An agent has reported ongoing authoring work. This signal expires if updates stop."
          : "Activity updates stopped. This does not mean the agent finished."
      }
    >
      <span className="host-authoring-activity-dot" aria-hidden="true" />
      {working
        ? activity.workingCount > 1
          ? `${activity.workingCount} agents working…`
          : "Agent working…"
        : "Activity unknown"}
    </span>
  );
}
