import {
  type JsonPrimitive,
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type AnchorRef,
  type ReviewAuthoringComponentName,
  type StoreRefData,
  reviewAuthoringPropsSchemas,
  storeRefData,
} from "./authoring";
import {
  type ReviewElementProps,
  type ReviewTextNode,
  TABLE_CELL_TAGS,
  tableAlignSchema,
} from "./review-document-data";
import {
  type AuditedComponentProps,
  FRAGMENT,
  type PublishAuditComponent,
  type PublishAuditNode,
  type ReviewDocumentPublishAudit,
  flattenChildren,
  isAuditElement,
  isPublishAuditComponent,
} from "./review-publish-element-audit";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";

type AuthoringProps<Name extends ReviewAuthoringComponentName> = z.infer<
  (typeof reviewAuthoringPropsSchemas)[Name]
>;

export type MaterializedComponentProps =
  | (Omit<AuthoringProps<"DatabaseLens">, "children" | "stores"> & {
      stores: Record<string, StoreRefData>;
    })
  | {
      [Name in Exclude<ReviewAuthoringComponentName, "DatabaseLens">]: Omit<
        AuthoringProps<Name>,
        "children"
      >;
    }[Exclude<ReviewAuthoringComponentName, "DatabaseLens">];

export interface MaterializedComponentNode {
  type: "component";
  name: ReviewAuthoringComponentName;
  props: MaterializedComponentProps;
  children: MaterializedReviewNode[];
}

export interface MaterializedElementNode {
  type: "element";
  // The document schema is what pins this to PROSE_TAGS.
  tag: string;
  props: ReviewElementProps;
  children: MaterializedReviewNode[];
}

export type MaterializedReviewNode =
  | ReviewTextNode
  | MaterializedElementNode
  | MaterializedComponentNode;

export interface MaterializedReviewDocument {
  body: MaterializedReviewNode[];
  errors: string[];
}

// The validation runtime already produced every element the document creates.
// This turns those records into JSON-shaped nodes. Prose keeps the React-named
// props emitted by the MDX compiler, while registry props are zod-parsed and
// normalized at the known non-JSON boundaries.
export function materializeReviewDocument(
  input: ReviewDocumentPublishAudit,
): MaterializedReviewDocument {
  const errors: string[] = [];
  const body = materializeChildren(input.tree, input, errors);
  return { body, errors };
}

function materializeChildren(
  node: PublishAuditNode,
  input: ReviewDocumentPublishAudit,
  errors: string[],
): MaterializedReviewNode[] {
  const nodes: MaterializedReviewNode[] = [];
  for (const child of flattenChildren(node)) {
    if (isStringValue(child) || isNumberValue(child)) {
      nodes.push({ type: "text", value: String(child) });
      continue;
    }
    if (!isAuditElement(child)) continue;
    if (child.type === FRAGMENT) {
      nodes.push(...materializeChildren(child.props.children, input, errors));
      continue;
    }

    const children = child.props.children;
    if (isStringValue(child.type)) {
      const { children: _children, key: _key, ...props } = child.props;
      const elementProps: ReviewElementProps = {};
      for (const [name, value] of Object.entries(props)) {
        // MDX emits GFM table alignment as a style object. Keep that one
        // semantic value as a scalar; arbitrary authored styles remain invalid.
        if (
          name === "style" &&
          TABLE_CELL_TAGS.some((tag) => tag === child.type) &&
          isObjectValue(value) &&
          "textAlign" in value &&
          Object.keys(value).length === 1 &&
          tableAlignSchema.safeParse(value.textAlign).success
        ) {
          elementProps.align = tableAlignSchema.parse(value.textAlign);
          continue;
        }
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
        children: materializeChildren(children, input, errors),
      });
      continue;
    }

    const name = input.componentNames.get(child.type);
    if (!name) {
      errors.push(
        isPublishAuditComponent(child.type)
          ? "Document-local components are not supported; use the Review components."
          : `Unsupported element type ${String(child.type)}.`,
      );
      continue;
    }

    const audited = input.componentProps.get(child);
    // A component whose props failed the audit already reported its errors.
    if (!audited) continue;
    nodes.push({
      type: "component",
      name,
      props: materializeComponentProps(audited),
      children: materializeChildren(children, input, errors),
    });
  }
  return nodes;
}

function materializeComponentProps(
  audited: AuditedComponentProps,
): MaterializedComponentProps {
  if (audited.name === "DatabaseLens") {
    const { children: _children, stores, ...props } = audited.props;
    return {
      ...props,
      stores: Object.fromEntries(
        Object.entries(stores).map(([id, store]) => [id, storeRefData(store)]),
      ),
    };
  }
  const { children: _children, ...props } = audited.props;
  return props;
}

interface SequenceRefExport {
  __kind: "review-sequence-ref";
  messages: readonly {
    anchor: { id: string };
    code?: { text: string };
  }[];
}

export type ReviewDocumentExportContainer =
  | NormalizedSoftwareModel
  | SequenceRefExport
  | AnchorRef
  | readonly ReviewDocumentExport[]
  | Readonly<ReviewDocumentModuleExports>;

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

// Both collectors walk the same executable module namespace with the same
// cycle guard; only the stopping rule differs. Anchor refs contain no
// software models and models contain no anchors, so each visitor is free to
// stop where the other would keep descending.
export function walkModuleExports(
  models: ReviewDocumentModuleExports,
  visit: (value: ReviewDocumentExportContainer) => "descend" | "skip",
): void {
  const visited = new Set<object>();
  const walk = (value: ReviewDocumentExport): void => {
    if (!isReviewDocumentExportContainer(value)) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (visit(value) === "skip") return;
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
      walk(entry);
    }
  };
  for (const value of Object.values(models)) walk(value);
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
  walkModuleExports(models, (value) => {
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
      return "skip";
    }
    return "descend";
  });
  return {
    anchors: Object.fromEntries(anchors),
    anchorContents: Object.fromEntries(anchorContents),
  };
}

export function collectDocumentSoftwareModels(
  models: ReviewDocumentModuleExports,
  preferredNames: readonly string[],
): NormalizedSoftwareModel[] {
  const result: NormalizedSoftwareModel[] = [];
  const seen = new Set<object>();
  const add = (value: ReviewDocumentExport) => {
    if (!isNormalizedSoftwareModel(value) || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  };
  for (const name of preferredNames) add(models[name]);
  walkModuleExports(models, (value) => {
    if (!isNormalizedSoftwareModel(value)) return "descend";
    add(value);
    return "skip";
  });
  return result;
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
