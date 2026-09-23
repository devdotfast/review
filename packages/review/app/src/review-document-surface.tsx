import type { ComponentProps, ReactElement } from "react";

import { ReviewDocumentMetaLine } from "./review-doc-meta";

export function ReviewDocumentTitle({
  children,
  ...props
}: ComponentProps<"h1">): ReactElement {
  return (
    <ReviewDocumentMetaLine>
      <h1 {...props} data-review-copy-prose>
        {children}
      </h1>
    </ReviewDocumentMetaLine>
  );
}
