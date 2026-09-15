import {
  type JsonPrimitive,
  type JsonValue,
  type ReviewDocumentLoad,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import {
  type AnchorRef,
  type StoreRef,
  hydrateStoreRef,
  tutorialAuthoringConversationPropsSchema,
} from "../../src/authoring";
import {
  type ReviewAuthoringComponentName,
  type ReviewComponentNode,
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
  name: ReviewAuthoringComponentName;
  props: HydratedReviewComponentProps;
  children: HydratedReviewNode[];
  /** Paragraphs generated from props rather than authored child nodes. */
  renderedParagraphs?: number;
  /** Text supplied by a component after its authored children. */
  renderedTextSuffix?: string;
}

export type HydratedReviewPropValue =
  | JsonPrimitive
  | AnchorRef
  | StoreRef
  | HydratedReviewPropValue[]
  | { [name: string]: HydratedReviewPropValue };

export interface HydratedReviewComponentProps {
  [name: string]: HydratedReviewPropValue;
}

// DatabaseLens stores regain symbol-backed collection refs, so hydrated
// component props have an explicit runtime type distinct from sealed JSON.
export type HydratedReviewNode =
  | HydratedReviewTextNode
  | HydratedReviewElementNode
  | HydratedReviewComponentNode;

export interface HydratedReviewDocument {
  contentHash: string;
  body: HydratedReviewNode[];
  anchors: ReadonlyMap<string, AnchorRef>;
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
  [K in ReviewAuthoringComponentName]?: (
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
  DatabaseLens: (node, props) => ({
    ...props,
    stores: Object.fromEntries(
      Object.entries(node.props.stores).map(([id, store]) => [
        id,
        hydrateStoreRef(store),
      ]),
    ),
  }),
};

function hydrateNode(
  node: ReviewNode,
  anchors: ReadonlyMap<string, AnchorRef>,
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

function hydrateComponentNode<K extends ReviewAuthoringComponentName>(
  node: Extract<ReviewComponentNode, { name: K }>,
  anchors: ReadonlyMap<string, AnchorRef>,
): HydratedReviewComponentNode {
  const walked = hydrateComponentProps(node.props, anchors);
  const children = node.children.map((child) => hydrateNode(child, anchors));

  const hydrate = componentHydrators[node.name];

  const hydrated: HydratedReviewComponentNode = {
    type: "component",
    name: node.name,
    props: hydrate ? hydrate(node, walked, children) : walked,
    children,
  };

  if (node.name === "TutorialViewButton") hydrated.renderedTextSuffix = "→";

  if (node.name === "TutorialAuthoringConversation") {
    hydrated.renderedParagraphs =
      tutorialAuthoringConversationPropsSchema.parse(
        node.props,
      ).conversation.messages.length;
  }

  return hydrated;
}

function hydrateComponentProps(
  props: ReviewComponentNode["props"],
  anchors: ReadonlyMap<string, AnchorRef>,
): HydratedReviewComponentProps {
  return Object.fromEntries(
    Object.entries(props).map(([name, value]) => [
      name,
      canonicalizeAnchorRefs(value, anchors),
    ]),
  );
}

function canonicalizeAnchorRefs(
  value: JsonValue,
  anchors: ReadonlyMap<string, AnchorRef>,
): HydratedReviewPropValue {
  if (Array.isArray(value)) {
    return value.map((child) => canonicalizeAnchorRefs(child, anchors));
  }

  if (!isJsonObject(value)) return value;

  const anchorId =
    jsonString(value.__kind) === "db-anchor-ref"
      ? jsonString(value.id)
      : undefined;

  if (anchorId !== undefined) {
    const canonical = anchors.get(anchorId);

    if (!canonical) {
      throw new Error(
        `Review document references missing anchor ${JSON.stringify(anchorId)}.`,
      );
    }

    return canonical;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      canonicalizeAnchorRefs(child, anchors),
    ]),
  );
}
