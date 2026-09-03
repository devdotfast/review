import { type ComponentProps, type ReactElement } from "react";

import { MarkdownCodeBlock } from "./code-block";
import { reviewAuthoringComponents } from "./review-authoring-components";
import { a } from "./review-components";
import { ReviewDocumentMetaLine } from "./review-doc-meta";
import type { ReviewDocumentComponent } from "./review-documents-runtime";

export const reviewDocumentComponents = {
  ...reviewAuthoringComponents,
  a,
  pre: MarkdownCodeBlock,
  h1: ReviewDocumentTitle,
};

function ReviewDocumentTitle({
  children,
  ...props
}: ComponentProps<"h1">): ReactElement {
  return (
    <>
      <h1 {...props}>{children}</h1>
      <ReviewDocumentMetaLine />
    </>
  );
}

export function ReviewDocumentContent({
  ReviewDocument,
}: {
  ReviewDocument: ReviewDocumentComponent;
}): ReactElement {
  return <ReviewDocument components={reviewDocumentComponents} />;
}
