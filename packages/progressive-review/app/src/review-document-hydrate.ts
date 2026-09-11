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
export type HydratedReviewTextNode = ReviewTextNode;

export interface HydratedReviewElementNode extends Omit<
  ReviewElementNode,
  "children"
> {
  children: HydratedReviewNode[];
}

export interface HydratedReviewComponentNode {
  type: "component";
  name: ReviewAuthoringComponentName;
  props: HydratedReviewComponentProps;
  children: HydratedReviewNode[];
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
  anchorContents: ReadonlyMap<string, string>;
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
  return {
    contentHash: load.contentHash,
    body: data.body.map((node) => hydrateNode(node, anchors)),
    anchors,
    anchorContents: new Map(Object.entries(data.anchorContents)),
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
  ) => HydratedReviewComponentProps;
};

const componentHydrators: ComponentHydrators = {
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
    return {
      ...node,
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
  const hydrate = componentHydrators[node.name];
  return {
    type: "component",
    name: node.name,
    props: hydrate ? hydrate(node, walked) : walked,
    children: node.children.map((child) => hydrateNode(child, anchors)),
  };
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
