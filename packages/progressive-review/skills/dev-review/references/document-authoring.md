# Document authoring

## Writing a great review

The H1 is the review's display title in Review Desktop tabs and Home. Write a short, specific title for the change (for example, "Publish pipeline: single mount"), not a generic one. Publishing syncs the title. Use progressive disclosure: short prose first, then details that earn their cost. Typical useful sections are interface change, lifecycle/data flow, state/storage, and testing evidence. Write in ASD-STE100 Simplified Technical English (STE).

Assume raw prose will confuse the reader. Spend substantial reasoning effort deciding what to omit, rather than what to include; deep analysis followed by a small amount of clear output text is the correct tradeoff. Start brief and add resolution only where it earns the reader's attention; the reader's time and attention are incredibly expensive and thus every word you put out taxes and pains them. Your job is to not waste that time. A useful trick is to write in ASD-STE100 Simplified Technical English (STE). Think about the style of RFCs from great tech leaders like Russ Cox, Dave Cheney, and the early React RFCs.

- Remember that the reader can ONLY see the 'user' prompts _before_ coding started and the document you write to explain what changed. This means jargon in the middle - references to specific parts of code, especially any and all abstractions, changes, and code referenced _during_ the editing process - is confusing and not helpful. More words do not help. Progressive disclosure of complexity is key.

1. In order to help a human understand a diff, there are likely <5 sections they would want to see in the markdown. This is a heuristic, not a hard requirement; use your best judgement and ask the user if you're unsure.
2. Here are some high-level sections which might be helpful (but are not limited to): dataflow/lifecycle, state model, architecture boundary, storage, risks.

- risks, in particular, are tricky to get right. Models tend to state obvious ones ('untested' x LOC) which are easy to catch, and miss important ones (customer X uses this workflow and we're not accounting for it). Risk assessment is fundamentally a question of user impact; you should ask for more context here instead of guessing before deciding on risks.
- These are three sections which are almost always relevant (esp. for larger changes):
  - **Interface change** — show any changed contract as its caller sees it (signature, RPC/HTTP/JSON shape, CLI flag, config, or event), with a short code example and a link to a real consumer.
  - **Testing** — connect the main claims to linked test evidence and say what remains unpinned.
  - **Decision Log** — split into two components:
    1. Collect and dedupe the invariants the user expressed to you in the prompt _in their own words_. Later decisions can semantically overwrite earlier ones.
    2. Decisions that you made during implementation. State them in plain language (ASD-STE100 Simplified Technical English).

## SDK Reference (data.ts file)

The `data.ts` file is the data layer of the review documents.

- The review runtime provides a typed SDK for source ranges and document-owned diagrams. It is available under the `virtual:progressive-review-authoring` module.
- Anchor props take `defineAnchors` references, never strings. Do not use
  casts, `any`, `<Participant>`, or `<Message>`.
- Do not import run-time values from local files. Put TypeScript-only support
  code in `data.ts`.

These are the supported runtime exports and their canonical input schemas:

```ts
export const defineActors = session.defineActors;
export const defineAnchors = session.defineAnchors;
export const defineStores = session.defineStores;

export const actorInputSchema = z.strictObject({
  label: nonEmptyStringSchema,
  softwareMapPath: optionalNonEmptyStringSchema,
});
export type ActorInput = z.infer<typeof actorInputSchema>;

export const actorInputMapSchema = z.record(
  nonEmptyStringSchema,
  actorInputSchema,
);
export type ActorInputMap = z.infer<typeof actorInputMapSchema>;

const codePeekCommonShape = {
  theme: z.enum(["system", "light", "dark"]).optional(),
  graph: z.enum(["head", "base"]).optional(),
  children: noChildrenSchema,
};

export const codePeekRangeInputSchema = z
  .strictObject({
    file: nonEmptyStringSchema,
    fromLine: z.int().positive(),
    toLine: z.int().positive(),
    ...codePeekCommonShape,
  })
  .refine((value) => value.toLine >= value.fromLine, {
    path: ["toLine"],
    message: "Must be greater than or equal to fromLine",
  });

export const codePeekPropsSchema = codePeekRangeInputSchema;

export const anchorInputSchema = z.strictObject({
  title: nonEmptyStringSchema,
  peek: codePeekPropsSchema.optional(),
  detail: optionalNonEmptyStringSchema,
  softwareMapPath: optionalNonEmptyStringSchema,
});

export const anchorInputMapSchema = z.record(
  nonEmptyStringSchema,
  z.union([nonEmptyStringSchema, anchorInputSchema]),
);
export type AnchorInputMap = z.infer<typeof anchorInputMapSchema>;

const softwareDataStoreForeignKeyRefSchema = z.union([
  nonEmptyStringSchema,
  z.strictObject({
    table: nonEmptyStringSchema,
    field: nonEmptyStringSchema,
    label: optionalNonEmptyStringSchema,
    cardinality: z.enum(["one-to-one", "many-to-one"]).optional(),
    onDelete: optionalNonEmptyStringSchema,
    onUpdate: optionalNonEmptyStringSchema,
  }),
]);
const softwareDataStoreFieldSchema: z.ZodType<SoftwareDataStoreFieldSchema> =
  z.lazy(() =>
    z.record(
      nonEmptyStringSchema,
      z.union([
        z.strictObject({
          type: nonEmptyStringSchema,
          example: z.unknown().optional(),
          pk: z.boolean().optional(),
          fk: softwareDataStoreForeignKeyRefSchema.optional(),
          schema: softwareDataStoreFieldSchema.optional(),
        }),
        softwareDataStoreFieldSchema,
      ]),
    ),
  );

export const softwareDataStoreCollectionInputSchema = z.strictObject({
  label: optionalNonEmptyStringSchema,
  key: optionalNonEmptyStringSchema,
  schema: softwareDataStoreFieldSchema,
});
const softwareDataStoreCollectionMapSchema = z.record(
  nonEmptyStringSchema,
  softwareDataStoreCollectionInputSchema,
);
export const storeKindSchema = z.enum(["relational", "document"]);
export const storeInputSchema = z.strictObject({
  kind: storeKindSchema,
  label: nonEmptyStringSchema,
  dataStoreKind: softwareDataStoreKindSchema.optional(),
  softwareMapPath: optionalNonEmptyStringSchema,
  tables: softwareDataStoreCollectionMapSchema.optional(),
  documents: softwareDataStoreCollectionMapSchema.optional(),
});

export const storeInputMapSchema = z.record(
  nonEmptyStringSchema,
  storeInputSchema,
);
export type StoreInputMap = z.infer<typeof storeInputMapSchema>;
```

Use the smallest source range that proves the claim. Do not use a broad region.
Read the range from the correct pinned worktree before you add the anchor.

## MDX Component Reference (review.mdx file)

The `review.mdx` file is the presentation layer of the review documents.

`SequenceDiagram` is more useful than prose for temporal behavior and
`DatabaseLens` for persisted-state changes. Visuals are cheaper to understand than prose.

- MDX uses JavaScript grammar.
- Write diagram inputs in `data.ts` instead; component schemas validate them.
- Every sequence message needs anchored peek or inline-code evidence.
- You're not limited the components below, although they are included by default. You are free to write any valid MDX that you would like to include to communicate the software system to the user, including arbitrary React + MDX.

These are the canonical prop schemas. `DbRead` and `DbWrite` both use
`dbOperationPropsSchema`.

```ts
const sequenceMessageBaseShape = {
  from: sequenceActorInputSchema,
  to: sequenceActorInputSchema,
  label: nonEmptyStringSchema,
};
export const sequenceMessageInputSchema = z.union([
  z.strictObject({
    ...sequenceMessageBaseShape,
    anchor: peekableAnchorRefSchema,
    code: sequenceMessageCodeInputSchema.optional(),
  }),
  z.strictObject({
    ...sequenceMessageBaseShape,
    anchor: anchorRefSchema.optional(),
    code: sequenceMessageCodeInputSchema,
  }),
]);

export const sequenceDiagramPropsSchema = z.strictObject({
  label: nonEmptyStringSchema,
  messages: z.array(sequenceMessageInputSchema).min(1),
  children: noChildrenSchema,
});

export const reviewCodePeekPropsSchema = z.strictObject({
  anchor: peekableAnchorRefSchema,
  children: noChildrenSchema,
});

export const anchorLinkPropsSchema = z.strictObject({
  anchor: peekableAnchorRefSchema,
  children: reactNodeSchema,
});

export const reviewSectionPropsSchema = z.strictObject({
  title: nonEmptyStringSchema,
  defaultCollapsed: z.boolean().optional(),
  children: reactNodeSchema,
});

export const dbUseCasePropsSchema = z.strictObject({
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  summary: optionalNonEmptyStringSchema,
  children: reactNodeSchema,
});

export const dbOperationPropsSchema = z.strictObject({
  from: z.union([actorRefSchema, targetRefSchema]),
  to: z.union([actorRefSchema, targetRefSchema]),
  label: nonEmptyStringSchema,
  anchor: peekableAnchorRefSchema,
  children: noChildrenSchema,
});

export const databaseLensPropsSchema = z.strictObject({
  title: optionalNonEmptyStringSchema,
  stores: z.record(
    nonEmptyStringSchema,
    z.custom<StoreRef>(
      (value) =>
        Boolean(value) &&
        typeof value === "object" &&
        (value as { __kind?: unknown }).__kind === "db-store-ref" &&
        typeof (value as { id?: unknown }).id === "string" &&
        typeof (value as { label?: unknown }).label === "string",
      "Must be a store reference returned by defineStores",
    ),
  ),
  height: z.number().positive().optional(),
  children: reactNodeSchema,
});
```

### Example document

`${DEV_REVIEW_HOME}/reviews/${uuid}/data.ts`

```ts
import {
  defineActors,
  defineAnchors,
} from "virtual:progressive-review-authoring";

export const actors = defineActors({
  agent: { label: "Agent" },
  desktop: { label: "Desktop" },
});

export const anchors = defineAnchors({
  resolveThing: {
    title: "Resolver",
    peek: { file: "src/resolve.ts", fromLine: 12, toLine: 28 },
  },
  publish: {
    title: "Publish",
    peek: { file: "src/publish.ts", fromLine: 40, toLine: 66 },
  },
});

export const messages = [
  {
    from: actors.agent,
    to: actors.desktop,
    label: "Publish candidate",
    anchor: anchors.publish,
  },
];
```

`${DEV_REVIEW_HOME}/reviews/${uuid}/review.mdx`

```mdx
import { anchors, messages } from "./data.ts";

<CodePeek anchor={anchors.resolveThing} />

<SequenceDiagram label="Publish" messages={messages} />
```
