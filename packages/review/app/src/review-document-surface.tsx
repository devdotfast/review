import {
  type ComponentProps,
  type FunctionComponent,
  type ReactElement,
} from "react";

import { MarkdownCodeBlock } from "./code-block";
import { reviewAuthoringComponents } from "./review-authoring-components";
import { a } from "./review-components";
import { ReviewDocumentMetaLine } from "./review-doc-meta";
import type {
  HydratedReviewComponentProps,
  HydratedReviewNode,
} from "./review-document-hydrate";
import {
  type ReviewDocumentComponents,
  renderReviewNodes,
} from "./review-document-renderer";

export const reviewDocumentComponents: ReviewDocumentComponents = {
  components: reviewAuthoringComponents,
  elementOverrides: {
    a,
    pre: MarkdownCodeBlock,
    h1: ReviewDocumentTitle,
  },
};

export function ReviewDocumentTitle({
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
  body,
}: {
  body: HydratedReviewNode[];
}): ReactElement {
  return <>{renderReviewNodes(body, reviewDocumentComponents)}</>;
}
