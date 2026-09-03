import { isObjectValue } from "@dev.fast/review-protocol";
import type { ComponentType, ReactNode } from "react";
import { z } from "zod";

import {
  type NormalizedSoftwareModel,
  type SoftwareDataStoreCollectionInput,
  type SoftwareDataStoreFieldLeaf,
  type SoftwareDataStoreFieldSchema,
  type SoftwareDataStoreKind,
} from "./software-map-model";
import type { SourceSnapshot } from "./source-code-types";

export { defineSoftwareMap as defineSoftwareModel } from "./software-map-model";

const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Must not be empty");
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const noChildrenSchema = z.never().optional();
const reactNodeSchema = z.custom<ReactNode>(
  (value) => value !== undefined && value !== null,
  "Must contain children",
);
const softwareDataStoreKindSchema = z.enum([
  "database",
  "objectStore",
  "bucket",
  "artifactStore",
  "fileStore",
]);

export interface ReviewDefinitionEnvironment {
  softwareMap: NormalizedSoftwareModel | null;
  baseSoftwareMap: NormalizedSoftwareModel | null;
  mapDependentComponents?: readonly string[];
  resolveCodePeek?(
    props: CodePeekProps,
    context?: CodePeekResolutionContext,
  ): Promise<CodePeekResolution>;
}

export interface CodePeekResolutionContext {
  anchorId: string;
}

export interface ReviewDefinitionDiagnostic {
  code: "software-map-unavailable";
  level: "info";
  message: string;
  remediation: "review map";
  component?: "SoftwareMap";
  path?: readonly string[];
}

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

export const actorRefSchema = z.strictObject({
  __kind: z.literal("db-actor-ref"),
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  softwareMapPath: optionalNonEmptyStringSchema,
});
export type ActorRef = z.infer<typeof actorRefSchema>;

const inlineSequenceActorSchema = z.strictObject({
  id: optionalNonEmptyStringSchema,
  label: nonEmptyStringSchema,
});
export const sequenceActorInputSchema = z.union([
  actorRefSchema,
  inlineSequenceActorSchema,
]);
export type SequenceActorInput = z.infer<typeof sequenceActorInputSchema>;

export const sequenceMessageCodeInputSchema = z.union([
  nonEmptyStringSchema,
  z.strictObject({
    language: optionalNonEmptyStringSchema,
    text: nonEmptyStringSchema,
  }),
]);
export type SequenceMessageCodeInput = z.infer<
  typeof sequenceMessageCodeInputSchema
>;

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
export type CodePeekRangeInput = z.infer<typeof codePeekRangeInputSchema>;

export const codePeekPropsSchema = codePeekRangeInputSchema;
export type CodePeekRoot = CodePeekRangeInput;
export type CodePeekProps = z.infer<typeof codePeekPropsSchema>;

export interface CodePeekDiffFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CodePeekDiffPayload {
  baseRef?: string;
  headRef?: string;
  orientation: "head" | "base";
  files: CodePeekDiffFile[];
}

export interface CodePeekResolution {
  snapshot: SourceSnapshot;
  diff?: CodePeekDiffPayload;
}

export const codePeekRefSchema = z.strictObject({
  __kind: z.literal("code-peek-ref"),
  props: codePeekPropsSchema,
  resolution: z.custom<CodePeekResolution>().nullable(),
});
export type CodePeekRef = z.infer<typeof codePeekRefSchema>;

export const anchorInputSchema = z.strictObject({
  title: nonEmptyStringSchema,
  peek: codePeekPropsSchema.optional(),
  detail: optionalNonEmptyStringSchema,
  softwareMapPath: optionalNonEmptyStringSchema,
});
export type AnchorInput = z.infer<typeof anchorInputSchema>;

export const anchorInputMapSchema = z.record(
  nonEmptyStringSchema,
  z.union([nonEmptyStringSchema, anchorInputSchema]),
);
export type AnchorInputMap = z.infer<typeof anchorInputMapSchema>;

// The `key: "Title"` shorthand becomes `{ title }` at the parse boundary, so
// definition code branches on one shape.
const anchorDefinitionMapSchema = z.record(
  nonEmptyStringSchema,
  z.union([
    nonEmptyStringSchema.transform((title): AnchorInput => ({ title })),
    anchorInputSchema,
  ]),
);

export const anchorRefSchema = z.strictObject({
  __kind: z.literal("db-anchor-ref"),
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  detail: optionalNonEmptyStringSchema,
  peek: codePeekRefSchema.optional(),
  softwareMapPath: optionalNonEmptyStringSchema,
});
export type AnchorRef = z.infer<typeof anchorRefSchema>;

export const peekableAnchorRefSchema = anchorRefSchema.extend({
  peek: codePeekRefSchema,
});
export type PeekableAnchorRef = z.infer<typeof peekableAnchorRefSchema>;

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
export type SequenceMessageInput = z.infer<typeof sequenceMessageInputSchema>;

export const sequenceDiagramPropsSchema = z.strictObject({
  label: nonEmptyStringSchema,
  messages: z.array(sequenceMessageInputSchema).min(1),
  children: noChildrenSchema,
});
export type SequenceDiagramProps = z.infer<typeof sequenceDiagramPropsSchema>;

export function isAnchorRef(value: unknown): value is AnchorRef {
  return anchorRefSchema.safeParse(value).success;
}

export function isPeekableAnchorRef(
  value: unknown,
): value is PeekableAnchorRef {
  return peekableAnchorRefSchema.safeParse(value).success;
}

export type AnchorRefFor<T extends AnchorInputMap[string]> = AnchorRef &
  (T extends { peek: infer Peek extends CodePeekProps }
    ? { peek: CodePeekRef & { props: Peek } }
    : unknown);

export const reviewCodePeekPropsSchema = z.strictObject({
  anchor: peekableAnchorRefSchema,
  children: noChildrenSchema,
});
export type ReviewCodePeekProps = z.infer<typeof reviewCodePeekPropsSchema>;

export const anchorLinkPropsSchema = z.strictObject({
  anchor: peekableAnchorRefSchema,
  children: reactNodeSchema,
});
export type AnchorLinkProps = z.infer<typeof anchorLinkPropsSchema>;

export const reviewSectionPropsSchema = z.strictObject({
  title: nonEmptyStringSchema,
  defaultCollapsed: z.boolean().optional(),
  children: reactNodeSchema,
});
export type ReviewSectionProps = z.infer<typeof reviewSectionPropsSchema>;

export const dbUseCasePropsSchema = z.strictObject({
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  summary: optionalNonEmptyStringSchema,
  children: reactNodeSchema,
});
export type DbUseCaseProps = z.infer<typeof dbUseCasePropsSchema>;

export const storeKindSchema = z.enum(["relational", "document"]);
export type StoreKind = z.infer<typeof storeKindSchema>;
export const collectionKindSchema = z.enum(["tables", "documents"]);
export type CollectionKind = z.infer<typeof collectionKindSchema>;

const targetRefShape = {
  __kind: z.literal("db-target-ref"),
  storeId: nonEmptyStringSchema,
  storeKind: storeKindSchema,
  storeLabel: nonEmptyStringSchema,
  storeDataStoreKind: softwareDataStoreKindSchema.optional(),
  storeSoftwareMapPath: optionalNonEmptyStringSchema,
  collectionKind: collectionKindSchema,
  collectionId: nonEmptyStringSchema,
  collectionLabel: nonEmptyStringSchema,
  collectionKey: optionalNonEmptyStringSchema,
  path: z.array(nonEmptyStringSchema),
};
export interface TargetRef {
  __kind: "db-target-ref";
  storeId: string;
  storeKind: StoreKind;
  storeLabel: string;
  storeDataStoreKind?: SoftwareDataStoreKind;
  storeSoftwareMapPath?: string;
  collectionKind: CollectionKind;
  collectionId: string;
  collectionLabel: string;
  collectionKey?: string;
  path: string[];
}

const authoredTargetRefKey: unique symbol = Symbol("authored-target-ref");
const collectionSchemaKey: unique symbol = Symbol("collection-schema");

export interface AuthoredTargetRef {
  readonly [authoredTargetRefKey]: TargetRef;
}

const resolvedTargetRefSchema = z.strictObject(targetRefShape);

export const targetRefSchema = z.preprocess(
  (value) => (isAuthoredTargetRef(value) ? value[authoredTargetRefKey] : value),
  resolvedTargetRefSchema,
);

// The handles defineStores returns carry their target under a private symbol;
// an authored `from`/`to` prop is decoded here before the schema sees it.
export function isAuthoredTargetRef(
  value: unknown,
): value is AuthoredTargetRef {
  return isObjectValue(value) && authoredTargetRefKey in value;
}

export function resolveTargetRef(
  value: AuthoredTargetRef | TargetRef | ActorRef | undefined,
): TargetRef | null {
  if (value === undefined) return null;
  if (authoredTargetRefKey in value) return value[authoredTargetRefKey];
  return value.__kind === "db-target-ref" ? value : null;
}

const dbOperationCommonShape = {
  label: nonEmptyStringSchema,
  anchor: peekableAnchorRefSchema,
  children: noChildrenSchema,
};

// Reads flow data out of the store (from: target, to: actor); writes flow
// into it. The direction is part of the schema so a swapped pair fails
// validation instead of silently resolving to no operation.
export const dbReadPropsSchema = z.strictObject({
  from: targetRefSchema,
  to: actorRefSchema,
  ...dbOperationCommonShape,
});
export type DbReadProps = Omit<z.input<typeof dbReadPropsSchema>, "from"> & {
  from: AuthoredTargetRef;
};

export const dbWritePropsSchema = z.strictObject({
  from: actorRefSchema,
  to: targetRefSchema,
  ...dbOperationCommonShape,
});
export type DbWriteProps = Omit<z.input<typeof dbWritePropsSchema>, "to"> & {
  to: AuthoredTargetRef;
};

export const dbOperationPropsSchema = z.union([
  dbReadPropsSchema,
  dbWritePropsSchema,
]);
export type DbOperationProps = z.infer<typeof dbOperationPropsSchema>;

// Only the identifying fields are parsed: `z.custom` keeps the store handle's
// identity, and with it the collection refs hanging off it.
const storeRefIdentitySchema = z.object({
  __kind: z.literal("db-store-ref"),
  id: z.string(),
  label: z.string(),
});

export const databaseLensPropsSchema = z.strictObject({
  title: optionalNonEmptyStringSchema,
  stores: z.record(
    nonEmptyStringSchema,
    z.custom<StoreRef>(
      (value) => storeRefIdentitySchema.safeParse(value).success,
      "Must be a store reference returned by defineStores",
    ),
  ),
  height: z.number().positive().optional(),
  children: reactNodeSchema,
});
export type DatabaseLensProps = z.infer<typeof databaseLensPropsSchema>;

// The model is the normalized structure defineSoftwareMap returns; `z.custom`
// keeps it by identity and only its shape is parsed.
const normalizedSoftwareModelSchema = z.object({
  elements: z.array(z.unknown()),
  elementsByPath: z.instanceof(Map),
  relationships: z.array(z.unknown()),
});

export const softwareMapPropsSchema = z.strictObject({
  model: z
    .custom<NormalizedSoftwareModel>(
      (value) => normalizedSoftwareModelSchema.safeParse(value).success,
      "Must be a normalized software model",
    )
    .optional(),
  title: optionalNonEmptyStringSchema,
  view: optionalNonEmptyStringSchema,
  height: z.union([z.number().positive(), nonEmptyStringSchema]).optional(),
  className: optionalNonEmptyStringSchema,
  placeholderLabel: optionalNonEmptyStringSchema,
  showChrome: z.boolean().optional(),
  showFloatingActions: z.boolean().optional(),
  children: noChildrenSchema,
});
export type SoftwareMapProps = z.infer<typeof softwareMapPropsSchema>;

export const tutorialKeymapPickerPropsSchema = z.strictObject({
  children: noChildrenSchema,
});
export type TutorialKeymapPickerProps = z.infer<
  typeof tutorialKeymapPickerPropsSchema
>;

export const tutorialAuthoringConversationSchema = z.strictObject({
  version: z.literal(1),
  title: nonEmptyStringSchema,
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        body: nonEmptyStringSchema,
      }),
    )
    .min(2),
});
export type TutorialAuthoringConversation = z.infer<
  typeof tutorialAuthoringConversationSchema
>;

export const tutorialAuthoringConversationPropsSchema = z.strictObject({
  conversation: tutorialAuthoringConversationSchema,
  children: noChildrenSchema,
});
export type TutorialAuthoringConversationProps = z.infer<
  typeof tutorialAuthoringConversationPropsSchema
>;

export const tutorialFeaturePropsSchema = z.strictObject({
  feature: z.literal("softwareMap"),
  children: reactNodeSchema,
});
export type TutorialFeatureProps = z.infer<typeof tutorialFeaturePropsSchema>;

export const tutorialViewButtonPropsSchema = z.strictObject({
  view: z.enum(["review", "commits", "diff", "map"]),
  children: reactNodeSchema,
});
export type TutorialViewButtonProps = z.infer<
  typeof tutorialViewButtonPropsSchema
>;

export const traceQuotePropsSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  trace: optionalNonEmptyStringSchema,
  event: z.number().int().nonnegative().optional(),
  children: reactNodeSchema.optional(),
});
export type TraceQuoteProps = z.infer<typeof traceQuotePropsSchema>;

export const callsAssertionSchema = z.strictObject({
  __kind: z.literal("call-assertion"),
  parent: peekableAnchorRefSchema,
  child: peekableAnchorRefSchema,
  reason: optionalNonEmptyStringSchema,
});
export type CallsAssertion = z.infer<typeof callsAssertionSchema>;

// An annotated hop in a call stack, for calls the reader cannot follow by
// eye (queues, callbacks, RPC). The entry renders the child frame with a
// dashed marker and the reason on hover.
export function calls(
  parent: PeekableAnchorRef,
  child: PeekableAnchorRef,
  reason?: string,
): CallsAssertion {
  // Shape validation only: the anchor refs keep their object identity
  // because peek resolution completes asynchronously on the originals.
  peekableAnchorRefSchema.parse(parent);
  peekableAnchorRefSchema.parse(child);
  if (reason !== undefined) nonEmptyStringSchema.parse(reason);
  return Object.freeze({
    __kind: "call-assertion",
    parent,
    child,
    ...(reason === undefined ? {} : { reason }),
  } satisfies CallsAssertion);
}

export const callStackEntrySchema = z.union([
  peekableAnchorRefSchema,
  callsAssertionSchema,
]);
export type CallStackEntry = z.infer<typeof callStackEntrySchema>;

export function isCallsAssertion(
  value: CallStackEntry,
): value is CallsAssertion {
  return value.__kind === "call-assertion";
}

// The frame a call-stack entry renders: the anchor itself, or the child of
// a calls() hop.
export function callStackEntryAnchor(entry: CallStackEntry): PeekableAnchorRef {
  return isCallsAssertion(entry) ? entry.child : entry;
}

// CallStackDiff renders two authored call stacks as one git-diff-styled
// stack. List order is the stack: each frame calls the one below it. The
// diff is positional over anchor identity. Anchors carry the side, so the
// rules below make every "-" row click to old code and every other row to
// new code:
//   1. A head frame must not use a base-graph anchor.
//   2. A base-only frame must use a base-graph anchor.
//   3. A shared frame is one head anchor listed in both lists.
export const callStackDiffPropsSchema = z
  .strictObject({
    title: optionalNonEmptyStringSchema,
    base: z.array(callStackEntrySchema),
    head: z.array(callStackEntrySchema),
    children: noChildrenSchema,
  })
  .superRefine((value, context) => {
    if (value.base.length === 0 && value.head.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["head"],
        message: "Must list at least one frame on base or head",
      });
      return;
    }
    const headIds = new Set(
      value.head.map((entry) => callStackEntryAnchor(entry).id),
    );
    value.head.forEach((entry, index) => {
      const anchor = callStackEntryAnchor(entry);
      if (anchor.peek.props.graph === "base") {
        context.addIssue({
          code: "custom",
          path: ["head", index],
          message: `Anchor "${anchor.id}" points at base; a head frame must point at head`,
        });
      }
    });
    value.base.forEach((entry, index) => {
      const anchor = callStackEntryAnchor(entry);
      if (anchor.peek.props.graph !== "base" && !headIds.has(anchor.id)) {
        context.addIssue({
          code: "custom",
          path: ["base", index],
          message: `Anchor "${anchor.id}" is a removed frame; give it graph: "base" so it points at the old code`,
        });
      }
    });
  });
export type CallStackDiffProps = z.infer<typeof callStackDiffPropsSchema>;

export interface ReviewAuthoringComponentRegistry {
  AnchorLink: ComponentType<AnchorLinkProps>;
  CallStackDiff: ComponentType<CallStackDiffProps>;
  CodePeek: ComponentType<ReviewCodePeekProps>;
  DatabaseLens: ComponentType<DatabaseLensProps>;
  DbRead: ComponentType<DbReadProps>;
  DbUseCase: ComponentType<DbUseCaseProps>;
  DbWrite: ComponentType<DbWriteProps>;
  ReviewSection: ComponentType<ReviewSectionProps>;
  SequenceDiagram: ComponentType<SequenceDiagramProps>;
  TraceQuote: ComponentType<TraceQuoteProps>;
  TutorialAuthoringConversation: ComponentType<TutorialAuthoringConversationProps>;
  TutorialFeature: ComponentType<TutorialFeatureProps>;
  TutorialKeymapPicker: ComponentType<TutorialKeymapPickerProps>;
  TutorialViewButton: ComponentType<TutorialViewButtonProps>;
}

// One props schema per authoring component, keyed by registry name. Publish
// validation walks the authored element tree and parses every element it
// recognizes with this map, so a component added to the registry gets
// publish-time prop validation by declaring its schema here — the `satisfies`
// clause makes omitting one a type error.
export const reviewAuthoringPropsSchemas = {
  AnchorLink: anchorLinkPropsSchema,
  CallStackDiff: callStackDiffPropsSchema,
  CodePeek: reviewCodePeekPropsSchema,
  DatabaseLens: databaseLensPropsSchema,
  DbRead: dbReadPropsSchema,
  DbUseCase: dbUseCasePropsSchema,
  DbWrite: dbWritePropsSchema,
  ReviewSection: reviewSectionPropsSchema,
  SequenceDiagram: sequenceDiagramPropsSchema,
  TraceQuote: traceQuotePropsSchema,
  TutorialAuthoringConversation: tutorialAuthoringConversationPropsSchema,
  TutorialFeature: tutorialFeaturePropsSchema,
  TutorialKeymapPicker: tutorialKeymapPickerPropsSchema,
  TutorialViewButton: tutorialViewButtonPropsSchema,
} satisfies Record<keyof ReviewAuthoringComponentRegistry, z.ZodType>;

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
export const storeInputSchema = z.strictObject({
  kind: storeKindSchema,
  label: nonEmptyStringSchema,
  dataStoreKind: softwareDataStoreKindSchema.optional(),
  softwareMapPath: optionalNonEmptyStringSchema,
  tables: softwareDataStoreCollectionMapSchema.optional(),
  documents: softwareDataStoreCollectionMapSchema.optional(),
});
export type StoreInput = z.infer<typeof storeInputSchema>;

export const storeInputMapSchema = z.record(
  nonEmptyStringSchema,
  storeInputSchema,
);
export type StoreInputMap = z.infer<typeof storeInputMapSchema>;

export interface StoreRef {
  __kind: "db-store-ref";
  id: string;
  kind: StoreKind;
  label: string;
  dataStoreKind?: SoftwareDataStoreKind;
  softwareMapPath?: string;
  tables?: Record<string, CollectionRef>;
  documents?: Record<string, CollectionRef>;
}

type CollectionHandle = AuthoredTargetRef & {
  readonly [collectionSchemaKey]: SoftwareDataStoreFieldSchema;
};

export type CollectionRef = CollectionHandle &
  Record<string, AuthoredTargetRef>;

export function collectionTargetRef(collection: CollectionRef): TargetRef {
  return collection[authoredTargetRefKey];
}

export function collectionSchema(
  collection: CollectionRef,
): SoftwareDataStoreFieldSchema {
  return collection[collectionSchemaKey];
}

export type CollectionRefs<T> =
  T extends Record<string, SoftwareDataStoreCollectionInput>
    ? {
        [K in keyof T]: CollectionHandle & FieldRefs<T[K]["schema"]>;
      }
    : never;

type FieldRefs<T> = T extends SoftwareDataStoreFieldLeaf
  ? T extends { schema: infer Schema extends SoftwareDataStoreFieldSchema }
    ? AuthoredTargetRef & FieldRefs<Schema>
    : AuthoredTargetRef
  : T extends SoftwareDataStoreFieldSchema
    ? {
        [K in keyof T]: AuthoredTargetRef &
          (T[K] extends SoftwareDataStoreFieldLeaf
            ? T[K] extends {
                schema: infer Schema extends SoftwareDataStoreFieldSchema;
              }
              ? FieldRefs<Schema>
              : unknown
            : T[K] extends SoftwareDataStoreFieldSchema
              ? FieldRefs<T[K]>
              : unknown);
      }
    : unknown;

export type StoreRefFor<T extends StoreInput> = Omit<
  StoreRef,
  "tables" | "documents"
> &
  (T["tables"] extends Record<string, SoftwareDataStoreCollectionInput>
    ? { tables: CollectionRefs<T["tables"]> }
    : { tables?: never }) &
  (T["documents"] extends Record<string, SoftwareDataStoreCollectionInput>
    ? { documents: CollectionRefs<T["documents"]> }
    : { documents?: never });

type SoftwareStoreRefFor<T extends SoftwareStoreInput> = Omit<
  StoreRef,
  "tables" | "documents"
> &
  (T["tables"] extends Record<string, SoftwareDataStoreCollectionInput>
    ? { tables: CollectionRefs<T["tables"]> }
    : Pick<StoreRef, "tables">) &
  (T["documents"] extends Record<string, SoftwareDataStoreCollectionInput>
    ? { documents: CollectionRefs<T["documents"]> }
    : Pick<StoreRef, "documents">);

const softwareActorObjectInputSchema = z.strictObject({
  path: nonEmptyStringSchema,
  label: optionalNonEmptyStringSchema,
});
type SoftwareActorDefinition = z.infer<typeof softwareActorObjectInputSchema>;

export const softwareActorInputSchema = z.union([
  nonEmptyStringSchema,
  softwareActorObjectInputSchema,
]);
export type SoftwareActorInput = z.infer<typeof softwareActorInputSchema>;

// The `id: "path"` shorthand becomes `{ path }` at the parse boundary.
const softwareActorDefinitionMapSchema = z.record(
  nonEmptyStringSchema,
  z.union([
    nonEmptyStringSchema.transform(
      (path): SoftwareActorDefinition => ({
        path,
      }),
    ),
    softwareActorObjectInputSchema,
  ]),
);

export const softwareStoreInputSchema = z.strictObject({
  path: nonEmptyStringSchema,
  label: optionalNonEmptyStringSchema,
  kind: storeKindSchema.optional(),
  tables: softwareDataStoreCollectionMapSchema.optional(),
  documents: softwareDataStoreCollectionMapSchema.optional(),
});
export type SoftwareStoreInput = z.infer<typeof softwareStoreInputSchema>;

export const softwareStoreInputMapSchema = z.record(
  nonEmptyStringSchema,
  softwareStoreInputSchema,
);
export type SoftwareStoreInputMap = z.infer<typeof softwareStoreInputMapSchema>;

export interface ReviewDefinitionSession {
  readonly diagnostics: readonly ReviewDefinitionDiagnostic[];
  begin(): void;
  ready(): Promise<void>;
  defineActors<T extends ActorInputMap>(input: T): { [K in keyof T]: ActorRef };
  defineAnchors<T extends AnchorInputMap>(
    input: T,
  ): { [K in keyof T]: AnchorRefFor<T[K]> };
  defineStores<T extends StoreInputMap>(
    input: T,
  ): { [K in keyof T]: StoreRefFor<T[K]> };
  defineSoftwareActors<T extends Record<string, SoftwareActorInput>>(
    model: NormalizedSoftwareModel,
    input: T,
  ): { [K in keyof T]: ActorRef };
  defineSoftwareStores<T extends SoftwareStoreInputMap>(
    model: NormalizedSoftwareModel,
    input: T,
  ): { [K in keyof T]: SoftwareStoreRefFor<T[K]> };
}

export function createReviewDefinitionSession(
  environment: ReviewDefinitionEnvironment,
): ReviewDefinitionSession {
  let pending: Promise<void>[] = [];
  const diagnostics: ReviewDefinitionDiagnostic[] = [];
  const reportMissingSoftwareMap = (
    context: { component: "SoftwareMap" } | { path: readonly PropertyKey[] },
  ): void => {
    const diagnostic = Object.freeze({
      code: "software-map-unavailable",
      level: "info",
      message:
        "component" in context
          ? "Document uses SoftwareMap but no software map is materialized for this repo; author one with `review map` or remove the section."
          : "Definition references softwareMapPath but no software map is materialized for this repo; author one with `review map` or remove the reference.",
      remediation: "review map",
      ...("component" in context
        ? { component: context.component }
        : { path: context.path.map(String) }),
    } satisfies ReviewDefinitionDiagnostic);
    if (
      diagnostics.some(
        (existing) => JSON.stringify(existing) === JSON.stringify(diagnostic),
      )
    ) {
      return;
    }
    diagnostics.push(diagnostic);
  };
  if (
    !environment.softwareMap &&
    environment.mapDependentComponents?.includes("SoftwareMap")
  ) {
    reportMissingSoftwareMap({ component: "SoftwareMap" });
  }
  return {
    diagnostics,
    begin() {
      pending = [];
    },
    async ready() {
      await Promise.all(pending);
    },
    defineActors: (input) =>
      defineActors(input, environment, reportMissingSoftwareMap),
    defineAnchors: (input) =>
      defineAnchors(input, environment, pending, reportMissingSoftwareMap),
    defineStores: (input) =>
      defineStores(input, environment, reportMissingSoftwareMap),
    defineSoftwareActors,
    defineSoftwareStores,
  };
}

function defineActors<T extends ActorInputMap>(
  input: T,
  environment: ReviewDefinitionEnvironment,
  reportMissingSoftwareMap: (context: { path: readonly PropertyKey[] }) => void,
): { [K in keyof T]: ActorRef } {
  actorInputMapSchema.parse(input);
  return Object.fromEntries(
    Object.entries(input).map(([id, actor]) => {
      requireDefinedSoftwareMapPath(
        environment,
        actor.softwareMapPath,
        [id, "softwareMapPath"],
        reportMissingSoftwareMap,
      );
      return [
        id,
        Object.freeze({
          __kind: "db-actor-ref",
          id,
          label: actor.label,
          softwareMapPath: actor.softwareMapPath,
        } satisfies ActorRef),
      ];
    }),
  ) as { [K in keyof T]: ActorRef };
}

function defineAnchors<T extends AnchorInputMap>(
  input: T,
  environment: ReviewDefinitionEnvironment,
  pending: Promise<void>[],
  reportMissingSoftwareMap: (context: { path: readonly PropertyKey[] }) => void,
): { [K in keyof T]: AnchorRefFor<T[K]> } {
  const anchors = anchorDefinitionMapSchema.parse(input);
  return Object.fromEntries(
    Object.entries(anchors).map(([id, anchor]) => {
      requireDefinedSoftwareMapPath(
        environment,
        anchor.softwareMapPath,
        [id, "softwareMapPath"],
        reportMissingSoftwareMap,
      );
      let peek: CodePeekRef | undefined;
      if (anchor.peek) {
        const props = validateCodePeekProps(anchor.peek);
        peek = {
          __kind: "code-peek-ref",
          props,
          resolution: null,
        };
        const resolveCodePeek = environment.resolveCodePeek;
        if (resolveCodePeek) {
          const resolution = resolveCodePeek(props, { anchorId: id }).then(
            (resolved) => {
              if (!codePeekResolutionHasSource(resolved)) {
                throwAuthoringIssue(
                  [id, "peek"],
                  "Code reference resolved without source",
                );
              }
              peek!.resolution = resolved;
              Object.freeze(peek);
            },
            (cause: unknown) => {
              throwAuthoringIssue(
                [id, "peek"],
                `Code range could not be resolved in the pinned worktree: ${errorMessage(cause)}`,
              );
            },
          );
          // Module evaluation registers all anchors before the generated
          // readiness barrier awaits them. A fast rejection in that gap must
          // remain observable by ready() without becoming a process-level
          // unhandled rejection.
          void resolution.catch(() => undefined);
          pending.push(resolution);
        }
      }
      return [
        id,
        Object.freeze({
          __kind: "db-anchor-ref",
          id,
          ...anchor,
          peek,
        } satisfies AnchorRef),
      ];
    }),
  ) as { [K in keyof T]: AnchorRefFor<T[K]> };
}

function codePeekResolutionHasSource(resolution: CodePeekResolution): boolean {
  return resolution.snapshot.roots.some((root) => {
    const source = resolution.snapshot.resolved[root.sourceId];
    return source?.lines.some((line) =>
      line.some((token) => token.t.trim().length > 0),
    );
  });
}

function defineStores<T extends StoreInputMap>(
  input: T,
  environment: ReviewDefinitionEnvironment,
  reportMissingSoftwareMap: (context: { path: readonly PropertyKey[] }) => void,
): { [K in keyof T]: StoreRefFor<T[K]> } {
  storeInputMapSchema.parse(input);
  return Object.fromEntries(
    Object.entries(input).map(([id, store]) => {
      requireDefinedSoftwareMapPath(
        environment,
        store.softwareMapPath,
        [id, "softwareMapPath"],
        reportMissingSoftwareMap,
      );
      const base: StoreRef = {
        __kind: "db-store-ref",
        id,
        kind: store.kind,
        label: store.label,
        dataStoreKind: store.dataStoreKind,
        softwareMapPath: store.softwareMapPath,
      };
      if (store.tables) {
        base.tables = defineCollections(id, store, "tables", store.tables);
      }
      if (store.documents) {
        base.documents = defineCollections(
          id,
          store,
          "documents",
          store.documents,
        );
      }
      return [id, Object.freeze(base)];
    }),
  ) as { [K in keyof T]: StoreRefFor<T[K]> };
}

export function validateCodePeekProps(input: CodePeekProps): CodePeekProps {
  return codePeekPropsSchema.parse(input);
}

function defineSoftwareActors<T extends Record<string, SoftwareActorInput>>(
  model: NormalizedSoftwareModel,
  input: T,
): { [K in keyof T]: ActorRef } {
  const actors = softwareActorDefinitionMapSchema.parse(input);
  return Object.fromEntries(
    Object.entries(actors).map(([id, actor]) => {
      const element = softwareElementForPath(model, actor.path, [id, "path"]);
      return [
        id,
        Object.freeze({
          __kind: "db-actor-ref",
          id,
          label: actor.label ?? element.label,
          softwareMapPath: element.path,
        } satisfies ActorRef),
      ];
    }),
  ) as { [K in keyof T]: ActorRef };
}

function defineSoftwareStores<T extends SoftwareStoreInputMap>(
  model: NormalizedSoftwareModel,
  input: T,
): { [K in keyof T]: SoftwareStoreRefFor<T[K]> } {
  softwareStoreInputMapSchema.parse(input);
  const stores = Object.fromEntries(
    Object.entries(input).map(([id, store]) => {
      const element = softwareElementForPath(model, store.path, [id, "path"]);
      if (element.type !== "dataStore") {
        throwAuthoringIssue(
          [id, "path"],
          `Software map element "${store.path}" must be a dataStore to back a DatabaseLens store`,
        );
      }
      return [
        id,
        {
          kind: store.kind ?? storeKindForDataStore(element.dataStoreKind),
          label: store.label ?? element.label,
          dataStoreKind: element.dataStoreKind,
          softwareMapPath: element.path,
          tables:
            store.tables ??
            authoredCollections(element.dataStoreSchema?.tables),
          documents:
            store.documents ??
            authoredCollections(element.dataStoreSchema?.documents),
        },
      ];
    }),
  ) as StoreInputMap;
  return defineStores(
    stores,
    {
      softwareMap: model,
      baseSoftwareMap: model,
      resolveCodePeek: async () => {
        throw new Error("defineSoftwareStores does not resolve code peeks");
      },
    },
    () => {},
  ) as { [K in keyof T]: SoftwareStoreRefFor<T[K]> };
}

function authoredCollections(
  collections:
    | Record<string, SoftwareDataStoreCollectionInput & { id?: string }>
    | undefined,
): Record<string, SoftwareDataStoreCollectionInput> | undefined {
  if (!collections) return undefined;
  return Object.fromEntries(
    Object.entries(collections).map(([key, { id: _id, ...collection }]) => [
      key,
      collection,
    ]),
  );
}

function defineCollections(
  storeId: string,
  store: StoreInput,
  collectionKind: CollectionKind,
  collections: Record<string, SoftwareDataStoreCollectionInput>,
): Record<string, CollectionRef> {
  return Object.fromEntries(
    Object.entries(collections).map(([collectionId, collection]) => {
      const collectionLabel = collection.label ?? collectionId;
      const target: TargetRef = {
        __kind: "db-target-ref",
        storeId,
        storeKind: store.kind,
        storeLabel: store.label,
        storeDataStoreKind: store.dataStoreKind,
        storeSoftwareMapPath: store.softwareMapPath,
        collectionKind,
        collectionId,
        collectionLabel,
        collectionKey: collection.key,
        path: [],
      };
      const fields = defineFieldTargets(target, collection.schema, []);
      // SAFETY: the handle's symbol-keyed target and schema are defined on
      // the next statement, before the collection ref escapes.
      const authored = Object.assign({}, fields) as CollectionRef;
      Object.defineProperties(authored, {
        [authoredTargetRefKey]: { value: Object.freeze(target) },
        [collectionSchemaKey]: { value: collection.schema },
      });
      return [collectionId, Object.freeze(authored)];
    }),
  );
}

function defineFieldTargets(
  collection: TargetRef,
  schema: SoftwareDataStoreFieldSchema,
  prefix: string[],
): Record<string, AuthoredTargetRef> {
  return Object.fromEntries(
    Object.entries(schema).map(([field, value]) => {
      const path = [...prefix, field];
      const target: TargetRef = {
        __kind: "db-target-ref",
        storeId: collection.storeId,
        storeKind: collection.storeKind,
        storeLabel: collection.storeLabel,
        storeDataStoreKind: collection.storeDataStoreKind,
        storeSoftwareMapPath: collection.storeSoftwareMapPath,
        collectionKind: collection.collectionKind,
        collectionId: collection.collectionId,
        collectionLabel: collection.collectionLabel,
        collectionKey: collection.collectionKey,
        path,
      };
      const nestedSchema = isNestedSchema(value) ? value : value.schema;
      // SAFETY: the symbol-keyed target is defined on the next statement,
      // before the field ref escapes.
      const authored = Object.assign(
        {},
        nestedSchema ? defineFieldTargets(collection, nestedSchema, path) : {},
      ) as AuthoredTargetRef & Record<string, AuthoredTargetRef>;
      Object.defineProperty(authored, authoredTargetRefKey, {
        value: Object.freeze(target),
      });
      return [field, Object.freeze(authored)];
    }),
  );
}

function isNestedSchema(
  value: SoftwareDataStoreFieldSchema[string],
): value is SoftwareDataStoreFieldSchema {
  // A leaf's `type` is its column type; on a nested schema `type` can only be
  // a field named "type".
  return !z.string().safeParse(value.type).success;
}

function softwareElementForPath(
  model: NormalizedSoftwareModel,
  path: string,
  propertyPath: PropertyKey[],
) {
  const element = model.elementsByPath.get(path);
  if (!element) {
    throwAuthoringIssue(
      propertyPath,
      "Must reference an existing software-map path",
    );
  }
  return element;
}

function requireDefinedSoftwareMapPath(
  environment: ReviewDefinitionEnvironment,
  path: string | undefined,
  propertyPath: PropertyKey[],
  reportMissingSoftwareMap: (context: { path: readonly PropertyKey[] }) => void,
): void {
  if (path === undefined) return;
  if (!environment.softwareMap) {
    reportMissingSoftwareMap({ path: propertyPath });
    return;
  }
  softwareElementForPath(environment.softwareMap, path, propertyPath);
}

const DATA_STORE_KIND_MAP: Record<SoftwareDataStoreKind, StoreKind> = {
  artifactStore: "document",
  bucket: "document",
  database: "relational",
  fileStore: "document",
  objectStore: "document",
};

function storeKindForDataStore(
  kind: SoftwareDataStoreKind | undefined,
): StoreKind {
  return kind === undefined ? "relational" : DATA_STORE_KIND_MAP[kind];
}

export function throwAuthoringIssue(
  path: PropertyKey[],
  message: string,
): never {
  throw new z.ZodError([{ code: "custom", path, message, input: undefined }]);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return String(cause);
}
