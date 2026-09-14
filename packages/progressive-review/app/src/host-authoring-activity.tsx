import type { HostActivitySnapshot } from "@dev.fast/review-protocol";
import { createContext, useContext } from "react";

import "./host-authoring-activity.css";

export type HostAuthoringActivity =
  | HostActivitySnapshot
  | "unknown"
  | undefined;
export const HostAuthoringActivityContext =
  createContext<HostAuthoringActivity>(undefined);

/** Optional chrome only: legacy and historical documents provide no activity. */
export function HostAuthoringActivityBadge() {
  const activity = useContext(HostAuthoringActivityContext);
  if (!activity) return null;
  const unknown = activity === "unknown";
  const working = !unknown && activity.workingCount > 0;
  if (!unknown && !working && activity.unknownCount === 0) return null;
  const label = working
    ? activity.workingCount > 1
      ? `${activity.workingCount} agents working…`
      : "Agent working…"
    : "Activity unknown";
  return (
    <span
      className="host-authoring-activity"
      data-active={working || undefined}
      role="status"
      aria-live="polite"
      title={
        working
          ? "An agent has declared an active authoring session."
          : "Activity updates stopped. This does not mean the agent finished."
      }
    >
      <span className="host-authoring-activity-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
