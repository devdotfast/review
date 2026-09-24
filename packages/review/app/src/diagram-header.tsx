import type { ReactNode } from "react";

export function DiagramHeader({
  kind,
  title,
  meta,
  action,
}: {
  kind: string;
  title?: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <figcaption className="diagram-header">
      <div className="diagram-header-main">
        <span className="diagram-kind-badge">{kind}</span>
        {title && (
          <span className="diagram-header-title" data-review-copy-prose>
            {title}
          </span>
        )}
        {meta && <em className="diagram-header-meta">{meta}</em>}
      </div>
      {action}
    </figcaption>
  );
}
