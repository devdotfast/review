import type { JsonObject } from "@dev.fast/whiteboard-protocol";
import {
  type JsonValue,
  isJsonObject,
  isStringValue,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
import type { ComponentType, ReactNode } from "react";
import { z } from "zod";

import {
  type AnchorRef,
  type WhiteboardAuthoringComponentName,
  type WhiteboardDocumentComponentName,
  anchorRefSchema,
  callStackEntrySchema,
  sequenceDiagramPropsSchema,
  whiteboardComponentDataSchemas,
} from "./authoring";
import { callStackFrames } from "./call-stack-frames";
import {
  type LegacyDbOperationNode,
  type LegacyDbUseCaseNode,
  databaseLensBlockFromLegacy,
  legacyDatabaseLensPropsSchema,
  legacyDbReadSchema,
  legacyDbUseCaseSchema,
  legacyDbWriteSchema,
} from "./database-lens-block";
import { migrateDiffSelections } from "./diff-selection-migration";
import { sequenceBlockFromProps } from "./sequence-steps";
import {
  type SoftwareModelData,
  softwareModelDataSchema,
} from "./software-map-model";

export const WHITEBOARD_DOCUMENT_FORMAT = "review-document/1";

export type {
  AnchorRef as DocumentAnchor,
  PeekableAnchorRef as DocumentPeekableAnchor,
  WhiteboardAuthoringComponentName,
  WhiteboardDocumentComponentName,
} from "./authoring";

export const PROSE_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "hr",
  "br",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "input",
  "img",
  "section",
  "sup",
  "sub",
  "b",
  "i",
  "kbd",
  "span",
  "s",
  "u",
  "small",
  "mark",
  "abbr",
  "cite",
  "q",
] as const;

export const proseTagSchema = z.enum(PROSE_TAGS);

export type ProseTag = z.infer<typeof proseTagSchema>;

// MDX emits GFM table alignment as a style object; the document keeps it as
// this scalar, and the renderer turns it back into `style.textAlign`.
export const tableAlignSchema = z.enum(["left", "center", "right"]);

export type TableAlign = z.infer<typeof tableAlignSchema>;

export const TABLE_CELL_TAGS = [
  "th",
  "td",
] as const satisfies readonly ProseTag[];

const PROSE_PROPS = new Set([
  "className",
  "href",
  "title",
  "id",
  "checked",
  "disabled",
  "start",
  "type",
  "alt",
  "src",
  "role",
  "tabIndex",
  "aria-describedby",
  "aria-label",
  "aria-hidden",
  "data-footnote-ref",
  "data-footnote-backref",
  "data-footnotes",
]);

const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;

export type WhiteboardElementProps = Record<string, string | number | boolean>;

export interface WhiteboardTextNode {
  type: "text";
  value: string;
}

export interface WhiteboardElementNode {
  type: "element";
  tag: ProseTag;
  props: WhiteboardElementProps;
  children: WhiteboardNode[];
}

interface WhiteboardComponentNodeOf<
  Name extends WhiteboardDocumentComponentName,
> {
  type: "component";
  name: Name;
  props: z.infer<(typeof whiteboardComponentDataSchemas)[Name]>;
  children: WhiteboardNode[];
}

export type WhiteboardComponentNode = {
  [Name in WhiteboardDocumentComponentName]: WhiteboardComponentNodeOf<Name>;
}[WhiteboardDocumentComponentName];

export type WhiteboardComponentProps<
  Name extends WhiteboardDocumentComponentName,
> = WhiteboardComponentNodeOf<Name>["props"];

/** The renderer registry: one component per document component, typed by the
 * props the sealed JSON carries. Prose children arrive positionally. */
export type WhiteboardDocumentComponentRegistry = {
  [Name in WhiteboardDocumentComponentName]: ComponentType<
    WhiteboardComponentProps<Name> & { children?: ReactNode }
  >;
};

export type WhiteboardNode =
  | WhiteboardTextNode
  | WhiteboardElementNode
  | WhiteboardComponentNode;

const whiteboardElementNodeSchema = z
  .strictObject({
    type: z.literal("element"),
    tag: proseTagSchema,
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    children: z.array(z.lazy(() => whiteboardNodeSchema)),
  })
  .superRefine((node, context) => {
    const isCell = TABLE_CELL_TAGS.some((tag) => tag === node.tag);

    for (const [key, value] of Object.entries(node.props)) {
      if (key === "align") {
        if (!isCell) {
          context.addIssue({
            code: "custom",
            path: ["props", "align"],
            message: `align is only allowed on ${TABLE_CELL_TAGS.map((tag) => `<${tag}>`).join(" and ")}`,
          });
        } else if (!tableAlignSchema.safeParse(value).success) {
          context.addIssue({
            code: "custom",
            path: ["props", "align"],
            message: `align "${String(value)}" must be left, center, or right`,
          });
        }

        continue;
      }

      if (!PROSE_PROPS.has(key) && !key.startsWith("data-review-")) {
        context.addIssue({
          code: "custom",
          path: ["props", key],
          message: `prop "${key}" is not allowed in review prose`,
        });
      }

      if (
        (key === "href" || key === "src") &&
        !(isStringValue(value) && SAFE_URL.test(value))
      ) {
        context.addIssue({
          code: "custom",
          path: ["props", key],
          message: `${key} "${String(value)}" uses a disallowed protocol`,
        });
      }
    }
  });

const componentNodeSchema = <
  Name extends WhiteboardDocumentComponentName,
  Props extends z.ZodType,
>(
  name: Name,
  props: Props,
) =>
  z.strictObject({
    type: z.literal("component"),
    name: z.literal(name),
    props,
    children: z.array(whiteboardNodeSchema),
  });

export const whiteboardNodeSchema: z.ZodType<WhiteboardNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), value: z.string() }),
    whiteboardElementNodeSchema,
    whiteboardComponentNodeSchema,
  ]),
);

// Unannotated on purpose: an annotated schema cannot be an option of a
// discriminated union. `satisfies` still pins it to WhiteboardComponentNode, so a
// registry component missing an entry below is a compile error.
export const whiteboardComponentNodeSchema = z.discriminatedUnion("name", [
  componentNodeSchema("AnchorLink", whiteboardComponentDataSchemas.AnchorLink),
  componentNodeSchema(
    "CallStackDiff",
    whiteboardComponentDataSchemas.CallStackDiff,
  ),
  componentNodeSchema("CodePeek", whiteboardComponentDataSchemas.CodePeek),
  componentNodeSchema(
    "DatabaseLens",
    whiteboardComponentDataSchemas.DatabaseLens,
  ),
  componentNodeSchema(
    "WhiteboardSection",
    whiteboardComponentDataSchemas.WhiteboardSection,
  ),
  componentNodeSchema(
    "SequenceDiagram",
    whiteboardComponentDataSchemas.SequenceDiagram,
  ),
  componentNodeSchema("TraceQuote", whiteboardComponentDataSchemas.TraceQuote),
  componentNodeSchema(
    "TutorialAuthoringConversation",
    whiteboardComponentDataSchemas.TutorialAuthoringConversation,
  ),
  componentNodeSchema(
    "TutorialFeature",
    whiteboardComponentDataSchemas.TutorialFeature,
  ),
  componentNodeSchema(
    "TutorialKeymapPicker",
    whiteboardComponentDataSchemas.TutorialKeymapPicker,
  ),
  componentNodeSchema(
    "TutorialViewButton",
    whiteboardComponentDataSchemas.TutorialViewButton,
  ),
]) satisfies z.ZodType<WhiteboardComponentNode>;

export interface WhiteboardDocumentData {
  format: typeof WHITEBOARD_DOCUMENT_FORMAT;
  title: string;
  routePath: string;
  sourcePath: string;
  body: WhiteboardNode[];
  anchors: Record<string, AnchorRef>;
  anchorContents: Record<string, string>;
  softwareModels: SoftwareModelData[];
}

export const whiteboardDocumentDataSchema: z.ZodType<WhiteboardDocumentData> =
  z.strictObject({
    format: z.literal(WHITEBOARD_DOCUMENT_FORMAT),
    title: z.string(),
    routePath: z.string(),
    sourcePath: z.string(),
    body: z.array(whiteboardNodeSchema),
    anchors: z.record(z.string(), anchorRefSchema),
    anchorContents: z.record(z.string(), z.string()),
    softwareModels: z.array(softwareModelDataSchema),
  });

/** Published documents once stored a code-peek ref
 * (`{ __kind: "code-peek-ref", props, resolution }`) where they now store a
 * diff selection. Sealed bundles are upgraded when read, never rewritten. */
export function upgradeWhiteboardDocumentJson(value: JsonValue): JsonValue {
  return upgradeDocumentNode(migrateDiffSelections(value));
}

function upgradeDocumentNode(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(upgradeDocumentNode);

  if (!isJsonObject(value)) return value;

  if (value.__kind === "code-peek-ref" && isJsonObject(value.props)) {
    const { file, fromLine, toLine, graph } = value.props;

    return {
      file,
      start: { side: graph ?? "head", line: fromLine },
      end: { side: graph ?? "head", line: toLine },
    };
  }

  const upgraded: JsonObject = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      upgradeDocumentNode(child),
    ]),
  );

  if (upgraded.type === "component" && upgraded.name === "ReviewSection")
    upgraded.name = "WhiteboardSection";

  // Call stacks once listed anchors and `calls()` hops; they now list frames.
  if (
    upgraded.type === "component" &&
    upgraded.name === "CallStackDiff" &&
    isJsonObject(upgraded.props)
  ) {
    const props = { ...upgraded.props };

    for (const side of ["base", "head"] as const) {
      const entries = props[side];

      if (Array.isArray(entries) && entries.some(isLegacyCallStackEntry))
        props[side] = parseJsonText(
          JSON.stringify(
            callStackFrames(z.array(callStackEntrySchema).parse(entries)),
          ),
        );
    }

    return { ...upgraded, props };
  }

  // Lenses once carried store handles and DbUseCase/DbRead/DbWrite children;
  // they now store one canonical block.
  if (
    upgraded.type === "component" &&
    upgraded.name === "DatabaseLens" &&
    isJsonObject(upgraded.props) &&
    isLegacyStoreMap(upgraded.props.stores)
  ) {
    const children = Array.isArray(upgraded.children) ? upgraded.children : [];

    const useCases = children.flatMap((child): LegacyDbUseCaseNode[] =>
      isJsonObject(child) &&
      child.type === "component" &&
      child.name === "DbUseCase"
        ? [
            {
              props: legacyDbUseCaseSchema.parse(child.props),
              operations: (Array.isArray(child.children)
                ? child.children
                : []
              ).flatMap((operation): LegacyDbOperationNode[] =>
                isJsonObject(operation) &&
                operation.type === "component" &&
                operation.name === "DbRead"
                  ? [
                      {
                        name: "DbRead" as const,
                        props: legacyDbReadSchema.parse(operation.props),
                      },
                    ]
                  : isJsonObject(operation) &&
                      operation.type === "component" &&
                      operation.name === "DbWrite"
                    ? [
                        {
                          name: "DbWrite" as const,
                          props: legacyDbWriteSchema.parse(operation.props),
                        },
                      ]
                    : [],
              ),
            },
          ]
        : [],
    );

    return {
      ...upgraded,
      props: parseJsonText(
        JSON.stringify(
          databaseLensBlockFromLegacy(
            legacyDatabaseLensPropsSchema.parse(upgraded.props),
            useCases,
          ),
        ),
      ),
      children: [],
    };
  }

  // Sequences once listed messages between actor refs; they now store steps.
  if (
    upgraded.type === "component" &&
    upgraded.name === "SequenceDiagram" &&
    isJsonObject(upgraded.props) &&
    upgraded.props.messages !== undefined
  )
    return {
      ...upgraded,
      props: parseJsonText(
        JSON.stringify(
          sequenceBlockFromProps(
            sequenceDiagramPropsSchema.parse(upgraded.props),
          ),
        ),
      ),
    };

  return upgraded;
}

function isLegacyStoreMap(value: JsonValue | undefined): boolean {
  return (
    isJsonObject(value) &&
    Object.values(value).some(
      (store) => isJsonObject(store) && store.__kind === "db-store-ref",
    )
  );
}

function isLegacyCallStackEntry(value: JsonValue): boolean {
  return isJsonObject(value) && value.__kind !== undefined;
}

export function walkWhiteboardNodes(
  nodes: WhiteboardNode[],
  visit: (node: WhiteboardNode, parent: WhiteboardComponentNode | null) => void,
  parent: WhiteboardComponentNode | null = null,
): void {
  for (const node of nodes) {
    visit(node, parent);

    if (node.type !== "text") {
      walkWhiteboardNodes(
        node.children,
        visit,
        node.type === "component" ? node : parent,
      );
    }
  }
}
