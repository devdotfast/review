import {
  type JsonPrimitive,
  type JsonValue,
  type ReviewDocumentLoad,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import {
  type DocumentAnchor,
  type ReviewComponentNode,
  type ReviewDocumentComponentName,
  type ReviewElementNode,
  type ReviewNode,
  type ReviewTextNode,
  reviewDocumentDataSchema,
} from "../../src/review-document-data";
import {
  type NormalizedSoftwareModel,
  hydrateSoftwareModel,
} from "../../src/software-map-model";
import { assignReviewHeadingIds } from "./review-document-headings";
import { reviewSectionSummary } from "./review-section-summary";

export type HydratedReviewTextNode = ReviewTextNode;

export interface HydratedReviewElementNode extends Omit<
  ReviewElementNode,
  "children"
> {
  children: HydratedReviewNode[];
  /** Runtime provenance: projected visibility may require new slug allocation. */
  generatedHeadingId?: boolean;
}

export interface HydratedReviewComponentNode {
  type: "component";
  name: ReviewDocumentComponentName;
  props: HydratedReviewComponentProps;
  children: HydratedReviewNode[];
  /** Paragraphs generated from props rather than authored child nodes. */
  renderedParagraphs?: number;
  /** Text supplied by a component after its authored children. */
  renderedTextSuffix?: string;
}

/** Sealed component props as the document carries them (plain JSON; optional
 * fields may be absent). A ReviewSection also gains its computed summary. */
export type HydratedReviewPropValue = JsonValue | undefined;

export interface HydratedReviewComponentProps {
  [name: string]: HydratedReviewPropValue;
}

// Hydrated component props are the sealed JSON props, untouched.
export type HydratedReviewNode =
  | HydratedReviewTextNode
  | HydratedReviewElementNode
  | HydratedReviewComponentNode;

export interface HydratedReviewDocument {
  contentHash: string;
  body: HydratedReviewNode[];
  anchors: ReadonlyMap<string, DocumentAnchor>;
  documentSoftwareModels: NormalizedSoftwareModel[];
  routePath: string;
  filePath: string;
}

export type ReadyReviewDocumentLoad = Extract<
  ReviewDocumentLoad,
  { state: "ready" }
>;

export function hydrateReviewDocument(
  load: ReadyReviewDocumentLoad,
): HydratedReviewDocument {
  const data = reviewDocumentDataSchema.parse(load.data);
  const anchors = new Map(Object.entries(data.anchors));
  const body = data.body.map((node) => hydrateNode(node, anchors));
  assignReviewHeadingIds(body);

  return {
    contentHash: load.contentHash,
    body,
    anchors,
    documentSoftwareModels: data.softwareModels.map(hydrateSoftwareModel),
    routePath: data.routePath,
    filePath: data.sourcePath,
  };
}

/**
 * Component props that need more than anchor canonicalization, keyed like
 * componentPropsSchema. A component with no entry keeps the walked props.
 */
type ComponentHydrators = {
  [K in ReviewDocumentComponentName]?: (
    node: Extract<ReviewComponentNode, { name: K }>,
    props: HydratedReviewComponentProps,
    children: HydratedReviewNode[],
  ) => HydratedReviewComponentProps;
};

const componentHydrators: ComponentHydrators = {
  ReviewSection: (node, props, children) => {
    if (!(children[0]?.type === "element" && children[0].tag === "h2")) {
      children.unshift({
        type: "element",
        tag: "h2",
        props: {},
        children: [{ type: "text", value: node.props.title }],
      });
    }

    return { ...props, summary: reviewSectionSummary(children) };
  },
};

function hydrateNode(
  node: ReviewNode,
  anchors: ReadonlyMap<string, DocumentAnchor>,
): HydratedReviewNode {
  if (node.type === "text") return node;

  if (node.type === "element") {
    const {
      "data-review-block-index": _blockIndex,
      "data-review-table": _table,
      "data-review-row": _row,
      "data-review-column": _column,
      ...props
    } = node.props;

    return {
      ...node,
      props,
      children: node.children.map((child) => hydrateNode(child, anchors)),
    };
  }

  return hydrateComponentNode(node, anchors);
}

function isTutorialConversationNode(
  node: ReviewComponentNode,
): node is Extract<
  ReviewComponentNode,
  { name: "TutorialAuthoringConversation" }
> {
  return node.name === "TutorialAuthoringConversation";
}

function hydrateComponentNode<K extends ReviewDocumentComponentName>(
  node: Extract<ReviewComponentNode, { name: K }>,
  anchors: ReadonlyMap<string, DocumentAnchor>,
): HydratedReviewComponentNode {
  // SAFETY: the document schema parsed `node.props` into plain JSON; only its
  // optional fields (typed `| undefined`) keep the object from matching the
  // JSON index signature structurally.
  const walked = node.props as HydratedReviewComponentProps;
  const children = node.children.map((child) => hydrateNode(child, anchors));

  const hydrate = componentHydrators[node.name];

  const hydrated: HydratedReviewComponentNode = {
    type: "component",
    name: node.name,
    props: hydrate ? hydrate(node, walked, children) : walked,
    children,
  };

  if (node.name === "TutorialViewButton") hydrated.renderedTextSuffix = "→";

  if (isTutorialConversationNode(node))
    hydrated.renderedParagraphs = node.props.conversation.messages.length;

  return hydrated;
}
