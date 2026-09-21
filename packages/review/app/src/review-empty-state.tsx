import type { ReactElement, ReactNode } from "react";

/**
 * The one empty state the review panes share: a document that cannot render,
 * a software map that cannot render, and commits with no pinned source.
 */
export function ReviewUnavailable({
  title,
  message,
  role = "alert",
  action,
}: {
  title?: string;
  message: ReactNode;
  role?: "alert" | "status";
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="review-empty-state" role={role}>
      {title ? <h2>{title}</h2> : null}
      <p>{message}</p>
      {action}
    </div>
  );
}
