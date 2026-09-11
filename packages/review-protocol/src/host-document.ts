import { z } from "zod";

export const HOST_LIMITS = Object.freeze({
  commandBytes: 2 * 1024 * 1024,
  operations: 100,
  nodes: 1_000,
  depth: 16,
  definitions: 2_000,
  nodeBytes: 256 * 1024,
  documentBytes: 4 * 1024 * 1024,
  diagramItems: 500,
  mapElements: 10_000,
  mapRelationships: 20_000,
  codeLines: 1_000,
  commentBytes: 32 * 1024,
  assetBytes: 5 * 1024 * 1024,
  assetPixels: 20_000_000,
});

export const HostIdSchema = z.uuid();
export const HostKeySchema = z
  .string()
  .max(80)
  .regex(/^(?!constructor$)(?!prototype$)[A-Za-z][A-Za-z0-9_-]*$/);
export const HostHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const HostOidSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const HostVersionSchema = z.number().int().nonnegative();
export const HostTimeSchema = z.iso.datetime();
export const HostSideSchema = z.enum(["base", "head"]);
export const HostRelativePathSchema = z
  .string()
  .max(4_096)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[:\\\u0000-\u001f\u007f])[^/]+(?:\/[^/]+)*$/,
    "must be a normalized repository-relative path",
  );
export const HostLinkSchema = z
  .url()
  .max(4_096)
  .regex(/^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f]+$/);

export type HostId = z.infer<typeof HostIdSchema>;
export type HostKey = z.infer<typeof HostKeySchema>;
export type HostHash = z.infer<typeof HostHashSchema>;
export type HostOid = z.infer<typeof HostOidSchema>;
export type HostVersion = z.infer<typeof HostVersionSchema>;

export const HostLabelSchema = z
  .string()
  .max(2_048)
  .regex(/\S/, "must not be blank");
export const HostTextSchema = z.string().max(HOST_LIMITS.nodeBytes);
const label = HostLabelSchema;
const text = HostTextSchema;
const language = z.string().max(100);
const ref = z
  .string()
  .max(1_024)
  .regex(/^[^\u0000-\u0020\u007f]+$/);
const line = z.number().int().positive();
const rangeFields = { fromLine: line, toLine: line };

// Zod records silently omit __proto__. Guard the original input before parsing;
// the generated schema retains the same property-name and count restrictions.
function keyedRecord<T extends z.ZodType>(
  valueSchema: T,
  maxProperties: number,
) {
  const record = z
    .record(HostKeySchema, valueSchema)
    .refine((value) => Object.keys(value).length <= maxProperties, {
      message: `must contain at most ${maxProperties} entries`,
    })
    .meta({ maxProperties });
  const jsonSchema = z.toJSONSchema(record, { io: "input" });
  delete jsonSchema.$schema;
  // SAFETY: The preprocessor only rejects forbidden keys; the typed record schema parses every accepted value.
  return z
    .preprocess((value, context) => {
      if (
        value !== null &&
        value !== undefined &&
        Object.prototype.hasOwnProperty.call(value, "__proto__")
      ) {
        context.addIssue({
          code: "custom",
          message: "__proto__ is not a permitted key",
        });
        return z.NEVER;
      }
      return value;
    }, record)
    .meta(jsonSchema) as z.ZodType<
    Record<string, z.output<T>>,
    Record<string, z.input<T>>
  >;
}

export const HostSourceRangeSchema = z
  .strictObject({
    side: HostSideSchema,
    file: HostRelativePathSchema,
    ...rangeFields,
  })
  .refine((range) => range.toLine >= range.fromLine, {
    path: ["toLine"],
    message: "must not precede fromLine",
  })
  .refine(
    (range) => range.toLine - range.fromLine + 1 <= HOST_LIMITS.codeLines,
    {
      path: ["toLine"],
      message: `must span at most ${HOST_LIMITS.codeLines} lines`,
    },
  );
export type HostSourceRange = z.infer<typeof HostSourceRangeSchema>;

export const HostSourceSpanSchema = z
  .strictObject({
    repositoryId: HostIdSchema,
    commit: HostOidSchema,
    blob: HostOidSchema,
    file: HostRelativePathSchema,
    ...rangeFields,
  })
  .refine((range) => range.toLine >= range.fromLine, {
    path: ["toLine"],
    message: "must not precede fromLine",
  })
  .refine(
    (range) => range.toLine - range.fromLine + 1 <= HOST_LIMITS.codeLines,
    {
      path: ["toLine"],
      message: `must span at most ${HOST_LIMITS.codeLines} lines`,
    },
  );
export type HostSourceSpan = z.infer<typeof HostSourceSpanSchema>;

export const HostSourceQuoteSchema = z.strictObject({
  span: HostSourceSpanSchema,
  text,
  sha256: HostHashSchema,
});
export type HostSourceQuote = z.infer<typeof HostSourceQuoteSchema>;

export const HostChangeSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("range"), baseRef: ref, headRef: ref }),
  z.strictObject({ kind: z.literal("branch"), name: ref, baseRef: ref }),
  z.strictObject({ kind: z.literal("jj_change"), changeId: ref, baseRef: ref }),
  z.strictObject({
    kind: z.literal("pull_request"),
    url: z.url({ protocol: /^https?$/ }).max(4_096),
  }),
  z.strictObject({ kind: z.literal("snapshot"), ref }),
]);
export type HostChangeSelector = z.infer<typeof HostChangeSelectorSchema>;
export const HostBindingSchema = z.strictObject({
  id: HostIdSchema,
  repositoryId: HostIdSchema,
  selector: HostChangeSelectorSchema,
  baseCommit: HostOidSchema,
  headCommit: HostOidSchema,
  createdAt: HostTimeSchema,
});
export type HostBinding = z.infer<typeof HostBindingSchema>;

export const HostFieldSchema = z.strictObject({
  label,
  dataType: label,
  nullable: z.boolean().optional(),
  primaryKey: z.boolean().optional(),
  references: z
    .strictObject({
      storeId: HostKeySchema,
      collectionId: HostKeySchema,
      fieldId: HostKeySchema,
    })
    .optional(),
});
export const HostCollectionSchema = z.strictObject({
  label,
  fields: keyedRecord(HostFieldSchema, HOST_LIMITS.definitions),
});
export const HostStoreEndpointSchema = z.strictObject({
  storeId: HostKeySchema,
  collectionId: HostKeySchema,
  fieldId: HostKeySchema.optional(),
});
export const HostMapElementRefSchema = z.strictObject({
  mapVersionId: HostIdSchema,
  elementId: HostKeySchema,
});
const storeFields = {
  storage: z.enum(["relational", "document"]),
  collections: keyedRecord(HostCollectionSchema, HOST_LIMITS.definitions),
};
export const HostDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("anchor"),
    title: label,
    detail: text.optional(),
    source: HostSourceRangeSchema,
  }),
  z.strictObject({
    kind: z.literal("actor"),
    label,
    mapElement: HostMapElementRefSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("store"), label, ...storeFields }),
]);
export type HostDefinition = z.infer<typeof HostDefinitionSchema>;

export const HostEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("anchor"), anchorId: HostKeySchema }),
  z.strictObject({
    kind: z.literal("illustrative_code"),
    language: language.default("text"),
    text,
  }),
  z.strictObject({
    kind: z.literal("explanation"),
    text: text.regex(/\S/, "must not be blank").optional(),
  }),
]);
export const HostInlineSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text,
    marks: z
      .array(
        z.enum([
          "strong",
          "emphasis",
          "strike",
          "underline",
          "sub",
          "sup",
          "highlight",
        ]),
      )
      .max(7)
      .refine(
        (marks) => new Set(marks).size === marks.length,
        "Marks must not repeat",
      )
      .refine(
        (marks) => !(marks.includes("sub") && marks.includes("sup")),
        "Subscript and superscript cannot be combined",
      )
      .optional(),
  }),
  z.strictObject({ type: z.literal("code"), text }),
  z.strictObject({ type: z.literal("break") }),
  z.strictObject({ type: z.literal("link"), href: HostLinkSchema, text }),
  z.strictObject({
    type: z.literal("anchor_link"),
    anchorId: HostKeySchema,
    text,
  }),
]);
export type HostInline = z.infer<typeof HostInlineSchema>;
export const HostSequenceMessageSchema = z.strictObject({
  id: HostKeySchema,
  fromActorId: HostKeySchema,
  toActorId: HostKeySchema,
  label,
  evidence: HostEvidenceSchema,
  style: z.enum(["call", "return", "async"]).default("call"),
});
export const HostStackFrameSchema = z.strictObject({
  id: HostKeySchema,
  anchorId: HostKeySchema,
  label: label.optional(),
  via: z
    .strictObject({
      kind: z.enum(["call", "queue", "callback", "rpc"]),
      reason: label,
    })
    .optional(),
});
export const HostDatabaseOperationSchema = z.strictObject({
  id: HostKeySchema,
  kind: z.enum(["read", "write"]),
  store: HostStoreEndpointSchema,
  actorId: HostKeySchema,
  label,
  anchorId: HostKeySchema,
});
export const HostDatabaseUseCaseSchema = z.strictObject({
  id: HostKeySchema,
  label,
  summary: text.optional(),
  operations: z
    .array(HostDatabaseOperationSchema)
    .max(HOST_LIMITS.diagramItems),
});
const nodeIdentity = { id: HostKeySchema };
export const HostNodeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("markdown"),
    markdown: text,
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("paragraph"),
    content: z.array(HostInlineSchema).max(HOST_LIMITS.nodeBytes),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("heading"),
    level: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    content: z.array(HostInlineSchema).max(HOST_LIMITS.nodeBytes),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("code"),
    language: language.default("text"),
    text,
    caption: text.optional(),
  }),
  z.strictObject({ ...nodeIdentity, type: z.literal("divider") }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("section"),
    title: label,
    defaultCollapsed: z.boolean().default(false),
    children: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("callout"),
    tone: z.enum(["info", "warning", "danger", "success"]).default("info"),
    title: label.optional(),
    children: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("code_peek"),
    anchorId: HostKeySchema,
    caption: text.optional(),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("sequence"),
    title: label,
    messages: z.array(HostSequenceMessageSchema).max(HOST_LIMITS.diagramItems),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("call_stack_diff"),
    title: label,
    base: z.array(HostStackFrameSchema).max(HOST_LIMITS.diagramItems),
    head: z.array(HostStackFrameSchema).max(HOST_LIMITS.diagramItems),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("database_lens"),
    title: label,
    storeIds: z.array(HostKeySchema).max(HOST_LIMITS.definitions),
    useCases: z.array(HostDatabaseUseCaseSchema).max(HOST_LIMITS.diagramItems),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("trace_quote"),
    traceId: HostIdSchema,
    eventId: HostIdSchema,
    text,
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("image"),
    assetId: HostIdSchema,
    alt: label,
    caption: text.optional(),
  }),
  z.strictObject({
    ...nodeIdentity,
    type: z.literal("software_map"),
    mapVersionId: HostIdSchema,
    focusElementId: HostKeySchema.optional(),
  }),
]);
export type HostNode = z.infer<typeof HostNodeSchema>;

export const HostDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roots: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  nodes: keyedRecord(HostNodeSchema, HOST_LIMITS.nodes),
  definitions: keyedRecord(HostDefinitionSchema, HOST_LIMITS.definitions),
});
export type HostDocument = z.infer<typeof HostDocumentSchema>;
export const HostDocumentManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roots: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  nodes: keyedRecord(HostHashSchema, HOST_LIMITS.nodes),
  definitions: keyedRecord(HostHashSchema, HOST_LIMITS.definitions),
  evidence: keyedRecord(HostHashSchema, HOST_LIMITS.definitions),
});
export type HostDocumentManifest = z.infer<typeof HostDocumentManifestSchema>;
export const HostDocumentStateSchema = HostDocumentSchema.extend({
  reviewId: HostIdSchema,
  reviewVersion: HostVersionSchema,
  binding: HostBindingSchema,
  contentHash: HostHashSchema,
  createdAt: HostTimeSchema,
  evidence: keyedRecord(HostSourceQuoteSchema, HOST_LIMITS.definitions),
});
export type HostDocumentState = z.infer<typeof HostDocumentStateSchema>;
export const HostPlacementSchema = z.strictObject({
  parentId: HostKeySchema.nullable(),
  position: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("start") }),
    z.strictObject({ kind: z.literal("end") }),
    z.strictObject({ kind: z.literal("after"), nodeId: HostKeySchema }),
  ]),
});
export type HostPlacement = z.infer<typeof HostPlacementSchema>;
const [
  markdownNode,
  paragraphNode,
  headingNode,
  codeNode,
  dividerNode,
  sectionNode,
  calloutNode,
  peekNode,
  sequenceNode,
  stackNode,
  databaseNode,
  traceNode,
  imageNode,
  mapNode,
] = HostNodeSchema.options;
// Only container child ownership differs from a full node. Derive the fields
// from the original schemas so JSON schemas and TypeScript stay in agreement.
export const HostNewNodeSchema = z.discriminatedUnion("type", [
  markdownNode,
  paragraphNode,
  headingNode,
  codeNode,
  dividerNode,
  sectionNode.extend({ children: z.tuple([]).default([]) }),
  calloutNode.extend({ children: z.tuple([]).default([]) }),
  peekNode,
  sequenceNode,
  stackNode,
  databaseNode,
  traceNode,
  imageNode,
  mapNode,
]);
export const HostNodeReplacementSchema = z.discriminatedUnion("type", [
  markdownNode,
  paragraphNode,
  headingNode,
  codeNode,
  dividerNode,
  sectionNode.omit({ children: true }),
  calloutNode.omit({ children: true }),
  peekNode,
  sequenceNode,
  stackNode,
  databaseNode,
  traceNode,
  imageNode,
  mapNode,
]);

const immutableNodeFields = { id: true, type: true } as const;
const containerFields = { ...immutableNodeFields, children: true } as const;
// Defaults apply to new/replaced values, never to omitted patch fields. Null
// clears only optional fields; nested values retain their normal input defaults.
export const HostNodePatchSchemas = {
  markdown: markdownNode.omit(immutableNodeFields).partial(),
  paragraph: paragraphNode.omit(immutableNodeFields).partial(),
  heading: headingNode.omit(immutableNodeFields).partial(),
  code: codeNode
    .omit(immutableNodeFields)
    .extend({ language, caption: text.nullable().optional() })
    .partial(),
  divider: z.never(),
  section: sectionNode
    .omit(containerFields)
    .extend({ defaultCollapsed: z.boolean() })
    .partial(),
  callout: calloutNode
    .omit(containerFields)
    .extend({
      tone: calloutNode.shape.tone.unwrap(),
      title: label.nullable().optional(),
    })
    .partial(),
  code_peek: peekNode
    .omit(immutableNodeFields)
    .extend({ caption: text.nullable().optional() })
    .partial(),
  sequence: sequenceNode.omit(immutableNodeFields).partial(),
  call_stack_diff: stackNode.omit(immutableNodeFields).partial(),
  database_lens: databaseNode.omit(immutableNodeFields).partial(),
  trace_quote: traceNode.omit(immutableNodeFields).partial(),
  image: imageNode
    .omit(immutableNodeFields)
    .extend({ caption: text.nullable().optional() })
    .partial(),
  software_map: mapNode
    .omit(immutableNodeFields)
    .extend({ focusElementId: HostKeySchema.nullable().optional() })
    .partial(),
};
export const HostNodePatchSchema = z
  .union(Object.values(HostNodePatchSchemas))
  .refine(
    (value) => Object.keys(value).length > 0,
    "A node update must change at least one field",
  );
export type HostNodePatch = z.output<typeof HostNodePatchSchema>;
export type HostNodePatchInput = z.input<typeof HostNodePatchSchema>;
export const HostDocumentOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("node.insert"),
    node: HostNewNodeSchema,
    placement: HostPlacementSchema,
  }),
  z.strictObject({
    op: z.literal("node.update"),
    nodeId: HostKeySchema,
    changes: HostNodePatchSchema,
  }),
  z.strictObject({
    op: z.literal("node.replace"),
    node: HostNodeReplacementSchema,
  }),
  z.strictObject({
    op: z.literal("node.move"),
    nodeId: HostKeySchema,
    placement: HostPlacementSchema,
  }),
  z.strictObject({
    op: z.literal("node.remove"),
    nodeId: HostKeySchema,
    recursive: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("definition.put"),
    id: HostKeySchema,
    value: HostDefinitionSchema,
  }),
  z.strictObject({ op: z.literal("definition.remove"), id: HostKeySchema }),
]);
export type HostDocumentOperation = z.input<typeof HostDocumentOperationSchema>;

export const HostMapElementSchema = z.strictObject({
  id: HostKeySchema,
  parentId: HostKeySchema.nullable(),
  label,
  description: text.default(""),
  kind: z.enum(["person", "system", "container", "component", "code", "store"]),
  source: z.array(HostSourceSpanSchema).max(HOST_LIMITS.diagramItems),
  store: z.strictObject(storeFields).optional(),
});
export const HostMapRelationshipSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: HostKeySchema,
    fromId: HostKeySchema,
    toId: HostKeySchema,
    kind: z.literal("call"),
    label,
    evidence: HostSourceSpanSchema,
  }),
  z.strictObject({
    id: HostKeySchema,
    fromId: HostKeySchema,
    toId: HostKeySchema,
    kind: z.literal("semantic"),
    label,
    explanation: label,
  }),
]);
export const HostMapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  elements: keyedRecord(HostMapElementSchema, HOST_LIMITS.mapElements),
  relationships: keyedRecord(
    HostMapRelationshipSchema,
    HOST_LIMITS.mapRelationships,
  ),
});
export type HostMap = z.infer<typeof HostMapSchema>;
export const HostMapVersionSchema = HostMapSchema.extend({
  id: HostIdSchema,
  mapId: HostIdSchema,
  repositoryId: HostIdSchema,
  commit: HostOidSchema,
  mapVersion: HostVersionSchema,
  contentHash: HostHashSchema,
  createdAt: HostTimeSchema,
});
export type HostMapVersion = z.infer<typeof HostMapVersionSchema>;
export const HostMapOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("element.put"),
    element: HostMapElementSchema,
  }),
  z.strictObject({ op: z.literal("element.remove"), id: HostKeySchema }),
  z.strictObject({
    op: z.literal("relationship.put"),
    relationship: HostMapRelationshipSchema,
  }),
  z.strictObject({ op: z.literal("relationship.remove"), id: HostKeySchema }),
]);
export type HostMapOperation = z.infer<typeof HostMapOperationSchema>;

export const HostDiagnosticSchema = z.strictObject({
  severity: z.enum(["error", "warning"]),
  code: label,
  message: text,
  path: z
    .string()
    .max(8_192)
    .regex(/^(?:\/(?:[^~]|~[01])*)*$/),
  nodeId: HostKeySchema.optional(),
  definitionId: HostKeySchema.optional(),
  relatedIds: z
    .array(z.string().max(128))
    .max(HOST_LIMITS.definitions)
    .optional(),
});
export type HostDiagnostic = z.infer<typeof HostDiagnosticSchema>;
export const HostValidationReportSchema = z.strictObject({
  valid: z.boolean(),
  basedOnReviewVersion: HostVersionSchema,
  diagnostics: z.array(HostDiagnosticSchema).max(HOST_LIMITS.definitions),
  affectedNodeIds: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
});
export type HostValidationReport = z.infer<typeof HostValidationReportSchema>;
export const HostDocumentCommitSchema = z.strictObject({
  reviewId: HostIdSchema,
  previousReviewVersion: HostVersionSchema,
  reviewVersion: HostVersionSchema,
  contentHash: HostHashSchema,
  createdAt: HostTimeSchema,
  changedNodes: keyedRecord(HostNodeSchema, HOST_LIMITS.nodes),
  removedNodeIds: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  changedDefinitions: keyedRecord(
    HostDefinitionSchema,
    HOST_LIMITS.definitions,
  ),
  removedDefinitionIds: z.array(HostKeySchema).max(HOST_LIMITS.definitions),
  changedEvidence: keyedRecord(HostSourceQuoteSchema, HOST_LIMITS.definitions),
  removedEvidenceIds: z.array(HostKeySchema).max(HOST_LIMITS.definitions),
  roots: z.array(HostKeySchema).max(HOST_LIMITS.nodes),
  binding: HostBindingSchema,
  diagnostics: z.array(HostDiagnosticSchema).max(HOST_LIMITS.definitions),
});
export type HostDocumentCommit = z.infer<typeof HostDocumentCommitSchema>;
