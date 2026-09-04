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
  storeRefDataSchema,
} from "../../src/authoring";
import {
  type ReviewComponentNode,
  type ReviewDocumentData,
  type ReviewElementNode,
  type ReviewNode,
  type ReviewTextNode,
  reviewDocumentDataSchema,
} from "../../src/review-document-data";
import {
  type NormalizedSoftwareModel,
  hydrateSoftwareModel,
} from "../../src/software-map-model";
import type { ReviewSession } from "./host/review-session";
import {
  resolveCodePeekRequest,
  runWithCodePeekResolutionSlot,
} from "./review-definition-runtime";

export type HydratedReviewTextNode = ReviewTextNode;

export interface HydratedReviewElementNode extends Omit<
  ReviewElementNode,
  "children"
> {
  children: HydratedReviewNode[];
}

export interface HydratedReviewComponentNode extends Omit<
  ReviewComponentNode,
  "props" | "children"
> {
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
  data: ReviewDocumentData;
  body: HydratedReviewNode[];
  anchors: ReadonlyMap<string, AnchorRef>;
  anchorContents: ReadonlyMap<string, string>;
  documentSoftwareModels: NormalizedSoftwareModel[];
  title: string;
  routePath: string;
  filePath: string;
}

type ReadyReviewDocumentLoad = Extract<ReviewDocumentLoad, { state: "ready" }>;

export function hydrateReviewDocument(
  load: ReadyReviewDocumentLoad,
): HydratedReviewDocument {
  const data = reviewDocumentDataSchema.parse(load.data);
  const anchors = new Map(Object.entries(data.anchors));
  return {
    contentHash: load.contentHash,
    data,
    body: data.body.map((node) => hydrateNode(node, anchors)),
    anchors,
    anchorContents: new Map(Object.entries(data.anchorContents)),
    documentSoftwareModels: data.softwareModels.map(hydrateSoftwareModel),
    title: data.title,
    routePath: data.routePath,
    filePath: data.sourcePath,
  };
}

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
  const props = hydrateComponentProps(node.props, anchors);
  if (node.name === "DatabaseLens") {
    const stores = node.props.stores;
    if (!isJsonObject(stores)) {
      throw new Error("Review document DatabaseLens stores are invalid.");
    }
    props.stores = Object.fromEntries(
      Object.entries(stores).map(([id, store]) => [
        id,
        hydrateStoreRef(storeRefDataSchema.parse(store)),
      ]),
    );
  }
  return {
    ...node,
    props,
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

export async function resolveReviewDocumentPeeks(
  document: HydratedReviewDocument,
  session: ReviewSession,
): Promise<void> {
  const uniqueAnchors = new Set(document.anchors.values());
  await Promise.all(
    [...uniqueAnchors].flatMap((anchor) => {
      if (!anchor.peek || anchor.peek.resolution) return [];
      return [
        runWithCodePeekResolutionSlot(async () => {
          anchor.peek!.resolution = await resolveCodePeekRequest(
            document.routePath,
            anchor.peek!.props,
            session,
          );
        }),
      ];
    }),
  );
}

const documentPromiseCache = new Map<
  string,
  Map<string, Promise<HydratedReviewDocument>>
>();
const MAX_SESSION_NAMESPACES = 32;
const MAX_DOCUMENTS_PER_SESSION = 4;

export function prepareReviewDocument(
  load: ReadyReviewDocumentLoad,
  session: ReviewSession,
): Promise<HydratedReviewDocument> {
  const namespace = reviewSessionCacheNamespace(session);
  let promises = documentPromiseCache.get(namespace);
  if (!promises) {
    while (documentPromiseCache.size >= MAX_SESSION_NAMESPACES) {
      const staleNamespace = documentPromiseCache.keys().next().value;
      if (staleNamespace === undefined) break;
      documentPromiseCache.delete(staleNamespace);
    }
    promises = new Map();
    documentPromiseCache.set(namespace, promises);
  }
  const cached = promises.get(load.contentHash);
  if (cached) return cached;
  while (promises.size >= MAX_DOCUMENTS_PER_SESSION) {
    const staleHash = promises.keys().next().value;
    if (staleHash === undefined) break;
    promises.delete(staleHash);
  }
  const promise = (async () => {
    const document = hydrateReviewDocument(load);
    await resolveReviewDocumentPeeks(document, session);
    return document;
  })();
  promises.set(load.contentHash, promise);
  void promise.catch(() => {
    if (promises?.get(load.contentHash) === promise) {
      promises.delete(load.contentHash);
    }
  });
  return promise;
}

function reviewSessionCacheNamespace(session: ReviewSession): string {
  return JSON.stringify([
    session.config.sessionUrl ?? "",
    session.config.sessionId ?? "",
    session.config.routePath ?? "/",
  ]);
}
