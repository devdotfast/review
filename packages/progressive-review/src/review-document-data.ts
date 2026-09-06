import {
  type JsonValue,
  isJsonObject,
  isStringValue,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type AnchorRef,
  type ReviewAuthoringComponentName,
  documentAnchorRefSchema,
  reviewComponentDataSchemas,
} from "./authoring";
import {
  type SoftwareModelData,
  softwareModelDataSchema,
} from "./software-map-model";

export const REVIEW_DOCUMENT_FORMAT = "review-document/1";

export type { ReviewAuthoringComponentName } from "./authoring";

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
  "sup",
  "section",
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
  // Footnote references and return links emitted by the Markdown compiler.
  "data-footnote-ref",
  "data-footnote-backref",
  "data-footnotes",
  "aria-describedby",
  "aria-label",
]);
const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;

export type ReviewElementProps = Record<string, string | number | boolean>;

export interface ReviewTextNode {
  type: "text";
  value: string;
}

export interface ReviewElementNode {
  type: "element";
  tag: string;
  props: ReviewElementProps;
  children: ReviewNode[];
}

interface ReviewComponentNodeOf<Name extends ReviewAuthoringComponentName> {
  type: "component";
  name: Name;
  props: z.infer<(typeof reviewComponentDataSchemas)[Name]>;
  children: ReviewNode[];
}

export type ReviewComponentNode = {
  [Name in ReviewAuthoringComponentName]: ReviewComponentNodeOf<Name>;
}[ReviewAuthoringComponentName];

export type ReviewNode =
  | ReviewTextNode
  | ReviewElementNode
  | ReviewComponentNode;

const reviewElementNodeSchema = z
  .strictObject({
    type: z.literal("element"),
    tag: proseTagSchema,
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    children: z.array(z.lazy(() => reviewNodeSchema)),
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
  Name extends ReviewAuthoringComponentName,
  Props extends z.ZodType,
>(
  name: Name,
  props: Props,
) =>
  z.strictObject({
    type: z.literal("component"),
    name: z.literal(name),
    props,
    children: z.array(reviewNodeSchema),
  });

export const reviewNodeSchema: z.ZodType<ReviewNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), value: z.string() }),
    reviewElementNodeSchema,
    reviewComponentNodeSchema,
  ]),
);

// Unannotated on purpose: an annotated schema cannot be an option of a
// discriminated union. `satisfies` still pins it to ReviewComponentNode, so a
// registry component missing an entry below is a compile error.
export const reviewComponentNodeSchema = z.discriminatedUnion("name", [
  componentNodeSchema("AnchorLink", reviewComponentDataSchemas.AnchorLink),
  componentNodeSchema(
    "CallStackDiff",
    reviewComponentDataSchemas.CallStackDiff,
  ),
  componentNodeSchema("CodePeek", reviewComponentDataSchemas.CodePeek),
  componentNodeSchema("DatabaseLens", reviewComponentDataSchemas.DatabaseLens),
  componentNodeSchema("DbRead", reviewComponentDataSchemas.DbRead),
  componentNodeSchema("DbUseCase", reviewComponentDataSchemas.DbUseCase),
  componentNodeSchema("DbWrite", reviewComponentDataSchemas.DbWrite),
  componentNodeSchema(
    "ReviewSection",
    reviewComponentDataSchemas.ReviewSection,
  ),
  componentNodeSchema(
    "SequenceDiagram",
    reviewComponentDataSchemas.SequenceDiagram,
  ),
  componentNodeSchema("TraceQuote", reviewComponentDataSchemas.TraceQuote),
  componentNodeSchema(
    "TutorialAuthoringConversation",
    reviewComponentDataSchemas.TutorialAuthoringConversation,
  ),
  componentNodeSchema(
    "TutorialFeature",
    reviewComponentDataSchemas.TutorialFeature,
  ),
  componentNodeSchema(
    "TutorialKeymapPicker",
    reviewComponentDataSchemas.TutorialKeymapPicker,
  ),
  componentNodeSchema(
    "TutorialViewButton",
    reviewComponentDataSchemas.TutorialViewButton,
  ),
]) satisfies z.ZodType<ReviewComponentNode>;

export interface ReviewDocumentData {
  format: typeof REVIEW_DOCUMENT_FORMAT;
  title: string;
  routePath: string;
  sourcePath: string;
  body: ReviewNode[];
  anchors: Record<string, AnchorRef>;
  anchorContents: Record<string, string>;
  softwareModels: SoftwareModelData[];
}

export const reviewDocumentDataSchema: z.ZodType<ReviewDocumentData> =
  z.strictObject({
    format: z.literal(REVIEW_DOCUMENT_FORMAT),
    title: z.string(),
    routePath: z.string(),
    sourcePath: z.string(),
    body: z.array(reviewNodeSchema),
    anchors: z.record(z.string(), documentAnchorRefSchema),
    anchorContents: z.record(z.string(), z.string()),
    softwareModels: z.array(softwareModelDataSchema),
  });

export function stripPeekResolutions<T>(value: T): T {
  // SAFETY: callers provide a materialized review value. JSON serialization
  // deep-copies that data while the replacer changes only code-peek resolution.
  return JSON.parse(
    JSON.stringify(value, (_key, current: JsonValue) =>
      isJsonObject(current) && current.__kind === "code-peek-ref"
        ? { ...current, resolution: null }
        : current,
    ),
  ) as T;
}

export function walkReviewNodes(
  nodes: ReviewNode[],
  visit: (node: ReviewNode, parent: ReviewComponentNode | null) => void,
  parent: ReviewComponentNode | null = null,
): void {
  for (const node of nodes) {
    visit(node, parent);
    if (node.type !== "text") {
      walkReviewNodes(
        node.children,
        visit,
        node.type === "component" ? node : parent,
      );
    }
  }
}
