import {
  type ComponentType,
  Fragment,
  type ReactNode,
  createElement,
} from "react";

import type { reviewAuthoringComponents } from "./review-authoring-components";
import type {
  HydratedReviewComponentNode,
  HydratedReviewNode,
} from "./review-document-hydrate";

export type ReviewDocumentComponents = typeof reviewAuthoringComponents &
  Record<string, ComponentType<never> | undefined>;

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
    const component = components[node.name];
    if (!component) {
      throw new Error(`Review document component ${node.name} is unavailable.`);
    }
    // SAFETY: component names passed the document schema; props were validated
    // at publish and hydrated above. This cast reconnects the registry type.
    const hydratedComponent = component as ComponentType<
      HydratedReviewComponentNode["props"]
    >;
    return createElement(hydratedComponent, node.props, ...children);
  }
  // SAFETY: prose tags and scalar props passed reviewNodeSchema before
  // hydration; an override consumes the same props as its intrinsic tag.
  const override = components[node.tag] as
    | ComponentType<(typeof node)["props"]>
    | undefined;
  return createElement(override ?? node.tag, node.props, ...children);
}
