import { type JsonValue, isJsonObject } from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type AnchorRef,
  anchorRefSchema,
  codePeekRefSchema,
  reviewAuthoringPropsSchemas,
  storeRefDataSchema,
} from "./authoring";
import {
  type SoftwareModelData,
  softwareModelDataSchema,
} from "./software-map-model";

export const REVIEW_DOCUMENT_FORMAT = "review-document/1";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type ReviewAuthoringComponentName =
  keyof typeof reviewAuthoringPropsSchemas;
// SAFETY: reviewAuthoringPropsSchemas is a non-empty, statically keyed object,
// and Object.keys returns exactly those runtime keys.
const componentNames = Object.keys(reviewAuthoringPropsSchemas) as [
  ReviewAuthoringComponentName,
  ...ReviewAuthoringComponentName[],
];

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
] as const;
const PROSE_PROPS = new Set([
  "className",
  "href",
  "title",
  "id",
  "align",
  "checked",
  "disabled",
  "start",
  "type",
  "alt",
  "src",
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

export interface ReviewComponentNode {
  type: "component";
  name: ReviewAuthoringComponentName;
  props: Record<string, JsonValue>;
  children: ReviewNode[];
}

export type ReviewNode =
  | ReviewTextNode
  | ReviewElementNode
  | ReviewComponentNode;

const elementPropsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .superRefine((props, context) => {
    for (const [key, value] of Object.entries(props)) {
      if (!PROSE_PROPS.has(key) && !key.startsWith("data-review-")) {
        context.addIssue({
          code: "custom",
          message: `prop "${key}" is not allowed in review prose`,
        });
      }
      const urlValue = z.string().safeParse(value);
      if (
        (key === "href" || key === "src") &&
        !(urlValue.success && SAFE_URL.test(urlValue.data))
      ) {
        context.addIssue({
          code: "custom",
          message: `${key} "${String(value)}" uses a disallowed protocol`,
        });
      }
    }
  });

const componentPropsSchema = (name: ReviewAuthoringComponentName): z.ZodType =>
  name === "DatabaseLens"
    ? z
        .object({ stores: z.record(z.string(), storeRefDataSchema) })
        .catchall(jsonValueSchema)
    : z.record(z.string(), jsonValueSchema);

export const reviewNodeSchema: z.ZodType<ReviewNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), value: z.string() }),
    z.strictObject({
      type: z.literal("element"),
      tag: z.enum(PROSE_TAGS),
      props: elementPropsSchema,
      children: z.array(reviewNodeSchema),
    }),
    z
      .strictObject({
        type: z.literal("component"),
        name: z.enum(componentNames),
        props: z.record(z.string(), jsonValueSchema),
        children: z.array(reviewNodeSchema),
      })
      .superRefine((node, context) => {
        const result = componentPropsSchema(node.name).safeParse(node.props);
        for (const issue of result.success ? [] : result.error.issues) {
          context.addIssue({
            code: "custom",
            path: ["props", ...issue.path],
            message: issue.message,
          });
        }
      }),
  ]),
);

const documentCodePeekRefSchema = codePeekRefSchema.extend({
  resolution: z.null(),
});
const documentAnchorRefSchema = anchorRefSchema.extend({
  peek: documentCodePeekRefSchema.optional(),
});

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
