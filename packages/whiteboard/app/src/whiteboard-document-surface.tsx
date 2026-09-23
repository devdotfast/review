import type { ComponentProps, ReactElement } from "react";

import { WhiteboardDocumentMetaLine } from "./whiteboard-doc-meta";

export function WhiteboardDocumentTitle({
  children,
  ...props
}: ComponentProps<"h1">): ReactElement {
  return (
    <WhiteboardDocumentMetaLine>
      <h1 {...props} data-whiteboard-copy-prose>
        {children}
      </h1>
    </WhiteboardDocumentMetaLine>
  );
}
