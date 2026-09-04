import {
  type JsonPrimitive,
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
} from "@dev.fast/review-protocol";
import { type ZodType } from "zod";

import {
  type AnchorRef,
  databaseLensPropsSchema,
  reviewAuthoringPropsSchemas,
  storeRefData,
} from "./authoring";
import {
  type ReviewComponentNode,
  type ReviewElementProps,
  type ReviewNode,
} from "./review-document-data";
import {
  type AuthoringComponentName,
  FRAGMENT,
  type PublishAuditComponent,
  type PublishAuditElementType,
  type PublishAuditNode,
  flattenChildren,
  isAuditElement,
  isPublishAuditComponent,
} from "./review-publish-element-audit";
import { type NormalizedSoftwareModel } from "./software-map-model";

interface ParsedComponentProps {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Each value has already passed its registry component's zod schema.
  [name: string]: unknown;
}

export interface MaterializedReviewDocument {
  body: ReviewNode[];
  errors: string[];
}

// The validation runtime already produced every element the document creates.
// This turns those records into JSON-shaped nodes. Prose keeps the React-named
// props emitted by the MDX compiler, while registry props are zod-parsed and
// normalized at the known non-JSON boundaries.
export function materializeReviewDocument(input: {
  tree: PublishAuditNode;
  componentNames: ReadonlyMap<PublishAuditElementType, AuthoringComponentName>;
}): MaterializedReviewDocument {
  const errors: string[] = [];
  const body = materializeChildren(input.tree, input.componentNames, errors);
  return { body, errors };
}

function materializeChildren(
  node: PublishAuditNode,
  componentNames: ReadonlyMap<PublishAuditElementType, AuthoringComponentName>,
  errors: string[],
): ReviewNode[] {
  const nodes: ReviewNode[] = [];
  for (const child of flattenChildren(node)) {
    if (isStringValue(child) || isNumberValue(child)) {
      nodes.push({ type: "text", value: String(child) });
      continue;
    }
    if (!isAuditElement(child)) continue;
    if (child.type === FRAGMENT) {
      nodes.push(
        ...materializeChildren(child.props.children, componentNames, errors),
      );
      continue;
    }

    const { children, key: _key, ...props } = child.props;
    if (isStringValue(child.type)) {
      const elementProps: ReviewElementProps = {};
      for (const [name, value] of Object.entries(props)) {
        if (
          isStringValue(value) ||
          isNumberValue(value) ||
          isBooleanValue(value)
        ) {
          elementProps[name] = value;
        } else {
          errors.push(
            `<${child.type}> prop "${name}" must be a string, number, or boolean.`,
          );
        }
      }
      nodes.push({
        type: "element",
        tag: child.type,
        props: elementProps,
        children: materializeChildren(children, componentNames, errors),
      });
      continue;
    }

    const name = componentNames.get(child.type);
    if (!name) {
      errors.push(
        isPublishAuditComponent(child.type)
          ? "Document-local components are not supported; use the Review components."
          : `Unsupported element type ${String(child.type)}.`,
      );
      continue;
    }

    const schema: ZodType = reviewAuthoringPropsSchemas[name];
    const parsed = schema.safeParse(child.props);
    if (!parsed.success) continue;
    if (!isObjectValue(parsed.data)) continue;
    const parsedData: ParsedComponentProps = Object.fromEntries(
      Object.entries(parsed.data),
    );
    const parsedProps: ParsedComponentProps = Object.fromEntries(
      Object.entries(parsed.data).filter(([key]) => key !== "children"),
    );
    nodes.push({
      type: "component",
      name,
      props: normalizeComponentProps(name, parsedData, parsedProps),
      children: materializeChildren(children, componentNames, errors),
    });
  }
  return nodes;
}

function normalizeComponentProps(
  name: AuthoringComponentName,
  parsedData: ParsedComponentProps,
  props: ParsedComponentProps,
): ReviewComponentNode["props"] {
  if (name === "DatabaseLens") {
    const parsed = databaseLensPropsSchema.parse(parsedData);
    const normalized: ParsedComponentProps = {
      ...props,
      stores: Object.fromEntries(
        Object.entries(parsed.stores).map(([id, store]) => [
          id,
          storeRefData(store),
        ]),
      ),
    };
    // SAFETY: DatabaseLens values passed its props schema, store handles were
    // projected to their data form, and the document schema is the final JSON
    // boundary before any materialized result can publish.
    return normalized as ReviewComponentNode["props"];
  }
  // SAFETY: props came from the named registry schema with children removed;
  // the document schema enforces its JSON representation before publication.
  return props as ReviewComponentNode["props"];
}

interface SequenceRefExport {
  __kind: "review-sequence-ref";
  messages: readonly {
    anchor: { id: string };
    code?: { text: string };
  }[];
}

interface ReviewDocumentExportRecord {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Review modules may export named authoring containers recursively.
  readonly [name: string]: ReviewDocumentExport;
}

type ReviewDocumentExportContainer =
  | NormalizedSoftwareModel
  | SequenceRefExport
  | AnchorRef
  | readonly ReviewDocumentExport[]
  | ReviewDocumentExportRecord;

export type ReviewDocumentExport =
  | ReviewDocumentExportContainer
  | PublishAuditComponent
  | JsonPrimitive
  | undefined;

export interface ReviewDocumentModuleExports {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- This owns the executable module namespace boundary being materialized.
  [name: string]: ReviewDocumentExport;
}

export interface CollectedReviewAnchors {
  anchors: Record<string, AnchorRef>;
  anchorContents: Record<string, string>;
}

// This intentionally mirrors the browser runtime's collection semantics so
// moving anchor collection to publish does not change identity or duplicate
// handling. The __kind checks stay structural because authored containers are
// walked before the document-data schema boundary.
export function collectReviewAnchors(
  models: ReviewDocumentModuleExports,
): CollectedReviewAnchors {
  const anchors = new Map<string, AnchorRef>();
  const anchorContents = new Map<string, string>();
  const visited = new Set<object>();
  const visit = (value: ReviewDocumentExport): void => {
    if (!isReviewDocumentExportContainer(value)) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (isSequenceRefExport(value)) {
      for (const message of value.messages) {
        if (!message.code) continue;
        const existing = anchorContents.get(message.anchor.id);
        if (existing !== undefined && existing !== message.code.text) {
          throw new Error(
            `Review anchor id "${message.anchor.id}" has more than one authored content body.`,
          );
        }
        anchorContents.set(message.anchor.id, message.code.text);
      }
    }
    if (isAnchorRefExport(value)) {
      const existing = anchors.get(value.id);
      if (existing && existing !== value) {
        throw new Error(
          `Review anchor id "${value.id}" is defined more than once.`,
        );
      }
      anchors.set(value.id, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  for (const value of Object.values(models)) visit(value);
  return {
    anchors: Object.fromEntries(anchors),
    anchorContents: Object.fromEntries(anchorContents),
  };
}

function isReviewDocumentExportContainer(
  value: ReviewDocumentExport,
): value is ReviewDocumentExportContainer {
  return isObjectValue(value);
}

function isSequenceRefExport(
  value: ReviewDocumentExportContainer,
): value is SequenceRefExport {
  return "__kind" in value && value.__kind === "review-sequence-ref";
}

function isAnchorRefExport(
  value: ReviewDocumentExportContainer,
): value is AnchorRef {
  return "__kind" in value && value.__kind === "db-anchor-ref";
}
