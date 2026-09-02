import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

import {
  peekableAnchorRefSchema,
  sequenceDiagramPropsSchema,
  storeInputMapSchema,
} from "./authoring";

export const liveReviewNodePropsSchema = z.strictObject({
  nodeId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  title: z.string().min(1).optional(),
});

export const liveReviewMarkdownPropsSchema = z.strictObject({
  source: z.string().min(1),
});

export const liveReviewTutorialPropsSchema = z.strictObject({
  anchors: z.record(z.string().min(1), peekableAnchorRefSchema),
});
export type LiveReviewTutorialProps = z.infer<
  typeof liveReviewTutorialPropsSchema
>;

const liveDatabaseActorSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
});

const liveDatabaseTargetSchema = z.strictObject({
  store: z.string().min(1),
  collectionKind: z.enum(["tables", "documents"]),
  collection: z.string().min(1),
  path: z.array(z.string().min(1)).default([]),
});

const liveDatabaseOperationSchema = z.strictObject({
  kind: z.enum(["read", "write"]),
  actor: liveDatabaseActorSchema,
  target: liveDatabaseTargetSchema,
  label: z.string().min(1),
  anchor: peekableAnchorRefSchema,
});

export const liveDatabaseLensPropsSchema = z.strictObject({
  title: z.string().min(1).optional(),
  stores: storeInputMapSchema,
  height: z.number().positive().optional(),
  useCases: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        label: z.string().min(1),
        summary: z.string().min(1).optional(),
        operations: z.array(liveDatabaseOperationSchema).min(1),
      }),
    )
    .min(1),
});
export type LiveDatabaseLensProps = z.infer<typeof liveDatabaseLensPropsSchema>;

export const liveReviewCatalog = defineCatalog(schema, {
  components: {
    ReviewNode: {
      props: liveReviewNodePropsSchema,
      slots: ["default"],
      description:
        "A stable authored Review node. Its title level is derived from depth.",
    },
    Markdown: {
      props: liveReviewMarkdownPropsSchema,
      slots: [],
      description: "Trusted Markdown prose parsed without executable MDX.",
    },
    SequenceDiagram: {
      props: sequenceDiagramPropsSchema,
      slots: [],
      description:
        "A Review-owned sequence diagram whose messages carry validated source evidence.",
    },
    DatabaseLens: {
      props: liveDatabaseLensPropsSchema,
      slots: [],
      description:
        "A Review-owned persisted-state diagram whose operations carry validated source evidence.",
    },
    Tutorial: {
      props: liveReviewTutorialPropsSchema,
      slots: [],
      description:
        "The trusted, shipped Review Desktop tutorial with pinned source evidence.",
    },
  },
  actions: {},
});
