import {
  type ComponentProps,
  type FunctionComponent,
  type ReactElement,
} from "react";

import type { ReviewAuthoringComponentName } from "../../src/review-document-data";
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
  // SAFETY: publish validated every component's props against its authoring
  // schema (reviewAuthoringPropsSchemas) and hydration rebuilt exactly the
  // runtime handles those props declare, so each registry entry accepts the
  // hydrated props carried by a node with its own name.
  components: reviewAuthoringComponents as typeof reviewAuthoringComponents &
    Record<
      ReviewAuthoringComponentName,
      FunctionComponent<HydratedReviewComponentProps>
    >,
  elementOverrides: {
    a,
    pre: MarkdownCodeBlock,
    h1: ReviewDocumentTitle,
  },
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
  body,
}: {
  body: HydratedReviewNode[];
}): ReactElement {
  return <>{renderReviewNodes(body, reviewDocumentComponents)}</>;
}
