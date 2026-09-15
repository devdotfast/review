import type { ReactElement } from "react";

import type { AnchorRef } from "../../src/authoring";

/**
 * Authored inline code shown in a side peek or tour stop. Lines are numbered
 * from the anchor's authored range when it has one, otherwise from 1.
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
  const firstLine = anchor.peek?.props.fromLine ?? 1;

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
