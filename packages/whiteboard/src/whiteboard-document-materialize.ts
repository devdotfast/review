import {
  type JsonPrimitive,
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
} from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import {
  type AnchorRef,
  type DatabaseLensProps,
  type StoreRefData,
  type WhiteboardAuthoringComponentName,
  storeRefData,
  whiteboardAuthoringPropsSchemas,
} from "./authoring";
import { callStackFrames } from "./call-stack-frames";
import {
  type DatabaseLensBlockProps,
  type LegacyDbOperationNode,
  type LegacyDbUseCaseNode,
  databaseLensBlockFromLegacy,
  legacyDbReadSchema,
  legacyDbUseCaseSchema,
  legacyDbWriteSchema,
} from "./database-lens-block";
import {
  type SequenceBlockProps,
  sequenceBlockFromProps,
} from "./sequence-steps";
import type { Frame } from "./session-api/document";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";
import {
  TABLE_CELL_TAGS,
  type WhiteboardElementProps,
  type WhiteboardTextNode,
  tableAlignSchema,
} from "./whiteboard-document-data";
import {
  type AuditedComponentProps,
  FRAGMENT,
  type PublishAuditComponent,
  type PublishAuditNode,
  type WhiteboardDocumentPublishAudit,
  flattenChildren,
  isAuditElement,
  isPublishAuditComponent,
} from "./whiteboard-publish-element-audit";

type AuthoringProps<Name extends WhiteboardAuthoringComponentName> = z.infer<
  (typeof whiteboardAuthoringPropsSchemas)[Name]
>;

type ProjectedComponentName =
  | "DatabaseLens"
  | "CallStackDiff"
  | "SequenceDiagram";

export type MaterializedComponentProps =
  | DatabaseLensBlockProps
  | (Omit<AuthoringProps<"CallStackDiff">, "children" | "base" | "head"> & {
      base: Frame[];
      head: Frame[];
    })
  | SequenceBlockProps
  | {
      [Name in Exclude<
        WhiteboardAuthoringComponentName,
        ProjectedComponentName
      >]: Omit<AuthoringProps<Name>, "children">;
    }[Exclude<WhiteboardAuthoringComponentName, ProjectedComponentName>];

export interface MaterializedComponentNode {
  type: "component";
  name: WhiteboardAuthoringComponentName;
  props: MaterializedComponentProps;
  children: MaterializedWhiteboardNode[];
}

export interface MaterializedElementNode {
  type: "element";
  // The document schema is what pins this to PROSE_TAGS.
  tag: string;
  props: WhiteboardElementProps;
  children: MaterializedWhiteboardNode[];
}

export type MaterializedWhiteboardNode =
  | WhiteboardTextNode
  | MaterializedElementNode
  | MaterializedComponentNode;

export interface MaterializedWhiteboardDocument {
  body: MaterializedWhiteboardNode[];
  errors: string[];
}

// The validation runtime already produced every element the document creates.
// This turns those records into JSON-shaped nodes. Prose keeps the React-named
// props emitted by the MDX compiler, while registry props are zod-parsed and
// normalized at the known non-JSON boundaries.
export function materializeWhiteboardDocument(
  input: WhiteboardDocumentPublishAudit,
): MaterializedWhiteboardDocument {
  const errors: string[] = [];
  const body = materializeChildren(input.tree, input, errors);

  return { body, errors };
}

function materializeChildren(
  node: PublishAuditNode,
  input: WhiteboardDocumentPublishAudit,
  errors: string[],
): MaterializedWhiteboardNode[] {
  const nodes: MaterializedWhiteboardNode[] = [];

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
      const elementProps: WhiteboardElementProps = {};

      for (const [name, value] of Object.entries(props)) {
        if (
          name === "data-review-block-index" ||
          name === "data-review-table" ||
          name === "data-review-row" ||
          name === "data-review-column" ||
          name === "data-review-block-tag"
        ) {
          continue;
        }

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
          ? "Document-local components are not supported; use the Whiteboard components."
          : `Unsupported element type ${String(child.type)}.`,
      );
      continue;
    }

    const audited = input.componentProps.get(child);

    // A component whose props failed the audit already reported its errors.
    if (!audited) continue;

    if (audited.name === "DatabaseLens") {
      nodes.push({
        type: "component",
        name,
        props: materializeDatabaseLens(
          audited.props,
          materializeChildren(children, input, errors),
        ),
        children: [],
      });
      continue;
    }

    nodes.push({
      type: "component",
      name,
      props: materializeComponentProps(audited),
      children: materializeChildren(children, input, errors),
    });
  }

  return nodes;
}

/** A lens and its `DbUseCase` / `DbRead` / `DbWrite` children lower to one
 * canonical block; the markers do not survive into the document. */
function materializeDatabaseLens(
  props: DatabaseLensProps,
  children: MaterializedWhiteboardNode[],
): DatabaseLensBlockProps {
  const useCases: LegacyDbUseCaseNode[] = [];

  for (const child of children) {
    if (child.type !== "component" || child.name !== "DbUseCase") continue;
    useCases.push({
      props: legacyDbUseCaseSchema.parse(child.props),
      operations: child.children.flatMap(
        (operation): LegacyDbOperationNode[] => {
          if (operation.type !== "component") return [];

          if (operation.name === "DbRead")
            return [
              {
                name: "DbRead" as const,
                props: legacyDbReadSchema.parse(operation.props),
              },
            ];

          if (operation.name === "DbWrite")
            return [
              {
                name: "DbWrite" as const,
                props: legacyDbWriteSchema.parse(operation.props),
              },
            ];

          return [];
        },
      ),
    });
  }

  const { children: _children, stores, ...rest } = props;

  return databaseLensBlockFromLegacy(
    {
      ...rest,
      stores: Object.fromEntries(
        Object.entries(stores).map(([id, store]) => [id, storeRefData(store)]),
      ),
    },
    useCases,
  );
}

function materializeComponentProps(
  audited: AuditedComponentProps,
): MaterializedComponentProps {
  if (audited.name === "SequenceDiagram")
    return sequenceBlockFromProps(audited.props);

  if (audited.name === "CallStackDiff") {
    const { children: _children, base, head, ...props } = audited.props;

    return {
      ...props,
      base: callStackFrames(base),
      head: callStackFrames(head),
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

export type WhiteboardDocumentExportContainer =
  | NormalizedSoftwareModel
  | SequenceRefExport
  | AnchorRef
  | readonly WhiteboardDocumentExport[]
  | Readonly<WhiteboardDocumentModuleExports>;

export type WhiteboardDocumentExport =
  | WhiteboardDocumentExportContainer
  | PublishAuditComponent
  | JsonPrimitive
  | undefined;

export interface WhiteboardDocumentModuleExports {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- This owns the executable module namespace boundary being materialized.
  [name: string]: WhiteboardDocumentExport;
}

export interface CollectedWhiteboardAnchors {
  anchors: Record<string, AnchorRef>;
  anchorContents: Record<string, string>;
}

// Both collectors walk the same executable module namespace with the same
// cycle guard; only the stopping rule differs. Anchor refs contain no
// software models and models contain no anchors, so each visitor is free to
// stop where the other would keep descending.
export function walkModuleExports(
  models: WhiteboardDocumentModuleExports,
  visit: (value: WhiteboardDocumentExportContainer) => "descend" | "skip",
): void {
  const visited = new Set<object>();

  const walk = (value: WhiteboardDocumentExport): void => {
    if (!isWhiteboardDocumentExportContainer(value)) return;

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
export function collectWhiteboardAnchors(
  models: WhiteboardDocumentModuleExports,
): CollectedWhiteboardAnchors {
  const anchors = new Map<string, AnchorRef>();
  const anchorContents = new Map<string, string>();
  walkModuleExports(models, (value) => {
    if (isSequenceRefExport(value)) {
      for (const message of value.messages) {
        if (!message.code) continue;
        const existing = anchorContents.get(message.anchor.id);

        if (existing !== undefined && existing !== message.code.text) {
          throw new Error(
            `Session anchor id "${message.anchor.id}" has more than one authored content body.`,
          );
        }

        anchorContents.set(message.anchor.id, message.code.text);
      }
    }

    if (isAnchorRefExport(value)) {
      const existing = anchors.get(value.id);

      if (existing && existing !== value) {
        throw new Error(
          `Session anchor id "${value.id}" is defined more than once.`,
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
  models: WhiteboardDocumentModuleExports,
  preferredNames: readonly string[],
): NormalizedSoftwareModel[] {
  const result: NormalizedSoftwareModel[] = [];
  const seen = new Set<object>();

  const add = (value: WhiteboardDocumentExport) => {
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

function isWhiteboardDocumentExportContainer(
  value: WhiteboardDocumentExport,
): value is WhiteboardDocumentExportContainer {
  return isObjectValue(value);
}

function isSequenceRefExport(
  value: WhiteboardDocumentExportContainer,
): value is SequenceRefExport {
  return "__kind" in value && value.__kind === "review-sequence-ref";
}

function isAnchorRefExport(
  value: WhiteboardDocumentExportContainer,
): value is AnchorRef {
  return "__kind" in value && value.__kind === "db-anchor-ref";
}
