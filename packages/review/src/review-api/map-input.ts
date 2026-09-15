import { z } from "zod";

import { softwareDataStoreCollectionInputSchema } from "../authoring.js";
import type { SoftwareModelInput } from "../software-map-model.js";

// Decode the existing map authoring format at the HTTP boundary. The existing
// defineSoftwareMap normalizer remains responsible for relationships/coverage.
const label = z.string().trim().min(1);

const range = z.strictObject({
  fromLine: z.number().int().positive(),
  toLine: z.number().int().positive(),
});

const relationship = z.union([
  z.strictObject({
    kind: z.literal("call"),
    from: label,
    to: label,
    label: z.string().optional(),
    description: z.string().optional(),
    nthCallSite: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("semantic"),
    from: label,
    to: label,
    label: z.string().optional(),
    description: z.string().optional(),
    semanticKind: z.string().optional(),
    sourceRanges: z.array(range).optional(),
  }),
]);

const base = z.strictObject({
  id: label.optional(),
  label: label.optional(),
  description: z.string().optional(),
  changeStatus: z
    .enum(["added", "removed", "modified", "unchanged"])
    .optional(),
  relationships: z.array(relationship).optional(),
});

const coverage = z.strictObject({
  files: z
    .array(
      z.union([
        label,
        z.strictObject({ path: label, ranges: z.array(range).optional() }),
      ]),
    )
    .optional(),
  globs: z.array(label).optional(),
});

const collection = <T extends z.ZodType>(schema: T) =>
  z.union([z.record(label, schema), z.array(schema)]);

const code = base.extend({
  sourceRanges: z.array(range.extend({ file: label })).optional(),
});

const component = base.extend({
  coverage: coverage.optional(),
  codeElements: collection(code).optional(),
});

const container = base.extend({
  coverage: coverage.optional(),
  components: collection(component).optional(),
});

const store = container.extend({
  kind: z
    .enum(["database", "objectStore", "bucket", "artifactStore", "fileStore"])
    .optional(),
  tables: z.record(label, softwareDataStoreCollectionInputSchema).optional(),
  documents: z.record(label, softwareDataStoreCollectionInputSchema).optional(),
});

const system = base.extend({
  coverage: coverage.optional(),
  external: z.boolean().optional(),
  containers: collection(container).optional(),
  dataStores: collection(store).optional(),
});

export const mapInputSchema: z.ZodType<SoftwareModelInput> = z.strictObject({
  people: collection(base).optional(),
  systems: collection(system).optional(),
  relationships: z.array(relationship).optional(),
});
