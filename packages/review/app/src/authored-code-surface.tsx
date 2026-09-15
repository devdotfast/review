import type { ReactElement } from "react";

import type { AnchorRef } from "../../src/authoring";

/**
 * Authored inline code shown in a side peek or tour stop. Lines are numbered
 * from the anchor's resolved source when it has one, otherwise from 1.
 */
export function AuthoredCodeSurface({
  anchor,
  code,
  language,
}: {
  anchor: AnchorRef;
  code: string;
  language?: string;
}): ReactElement {
  const resolution = anchor.peek?.resolution;
  const firstLine = resolution ? resolvedSourceFirstLine(resolution) : 1;

  return (
    <div className="panel-code-block">
      <pre
        className="panel-static-code-surface panel-authored-code-surface panel-authored-code-block"
        data-language={language}
      >
        {code
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .map((text, index) => (
            <span
              className="panel-static-code-line"
              key={`line:${firstLine + index}`}
            >
              <span className="panel-static-code-gutter">
                {firstLine + index}
              </span>
              <span className="panel-static-code-marker" aria-hidden="true">
                {" "}
              </span>
              <code>{text || " "}</code>
            </span>
          ))}
      </pre>
    </div>
  );
}

function resolvedSourceFirstLine(
  resolution: NonNullable<NonNullable<AnchorRef["peek"]>["resolution"]>,
): number {
  const root = resolution.snapshot.roots[0];
  const resolved = root ? resolution.snapshot.resolved[root.sourceId] : null;

  if (!resolved) {
    throw new Error("CodePeek resolution contains no resolved root source.");
  }

  return resolved.source.line;
}
