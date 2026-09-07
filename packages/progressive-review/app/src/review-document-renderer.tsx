import { jsonString } from "@dev.fast/review-protocol";
import {
  Fragment,
  type FunctionComponent,
  type ReactNode,
  createElement,
} from "react";

import {
  type ProseTag,
  type ReviewAuthoringComponentName,
  type ReviewElementProps,
  tableAlignSchema,
} from "../../src/review-document-data";
import type {
  HydratedReviewComponentProps,
  HydratedReviewNode,
} from "./review-document-hydrate";
import { ReviewLiveNode } from "./review-live-node";

/** A prose override renders the same validated props as its intrinsic tag. */
export type ProseElementComponent = FunctionComponent<
  ReviewElementProps & { children?: ReactNode }
>;

export interface ReviewDocumentComponents {
  components: Record<
    ReviewAuthoringComponentName,
    FunctionComponent<HydratedReviewComponentProps>
  >;
  elementOverrides: Partial<Record<ProseTag, ProseElementComponent>>;
}

export function renderReviewNodes(
  nodes: HydratedReviewNode[],
  components: ReviewDocumentComponents,
): ReactNode {
  return createElement(
    Fragment,
    null,
    ...nodes.map((node) => renderNode(node, components)),
  );
}

function renderNode(
  node: HydratedReviewNode,
  components: ReviewDocumentComponents,
): ReactNode {
  if (node.type === "text") return node.value;
  const children = node.children.map((child) => renderNode(child, components));
  if (node.type === "component") {
    return createElement(
      components.components[node.name],
      node.props,
      ...children,
    );
  }
  const liveId = jsonString(node.props.id);
  const liveRevision = jsonString(node.props.className);
  if (
    node.tag === "section" &&
    liveId?.startsWith("review-node-") &&
    liveRevision?.startsWith("review-live-")
  ) {
    return createElement(
      ReviewLiveNode,
      {
        key: liveId,
        id: liveId,
        revision: liveRevision,
      },
      ...children,
    );
  }
  const override = components.elementOverrides[node.tag];
  if (override) return createElement(override, node.props, ...children);
  // Alignment is the one saved style the renderer restores: the publish
  // schema validates it, and the inline style keeps the document's table CSS
  // from overriding an authored column alignment.
  const align = tableAlignSchema.safeParse(node.props.align);
  if (align.success) {
    return createElement(
      node.tag,
      { ...node.props, style: { textAlign: align.data } },
      ...children,
    );
  }
  return createElement(node.tag, node.props, ...children);
}
