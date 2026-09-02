import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

import { sequenceDiagramPropsSchema } from "./authoring";

export const liveReviewNodePropsSchema = z.strictObject({
  nodeId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  title: z.string().min(1).optional(),
});

export const liveReviewMarkdownPropsSchema = z.strictObject({
  source: z.string().min(1),
});

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
  },
  actions: {},
});
