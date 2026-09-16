/**
 * Hand-maintained mirror of diffr's src/protocol/mod.rs and src/pairing.rs.
 * Update these types and validators together when the Rust wire format changes.
 * Serde omits default/empty fields rather than sending null. Lines are zero-based,
 * columns are UTF-8 byte offsets, and ranges are half-open.
 */
import { z } from "zod";

/** A pairing always has at least one side; additions/deletions omit the other. */
export type StructuralPairing<T> =
  | { lhs: T; rhs: T }
  | { lhs: T; rhs?: never }
  | { rhs: T; lhs?: never };
function structuralPairingSchema<T>(
  value: z.ZodType<T>,
): z.ZodType<StructuralPairing<T>> {
  return z.union([
    z.object({ lhs: value, rhs: value }),
    z.object({ lhs: value, rhs: z.never().optional() }),
    z.object({ rhs: value, lhs: z.never().optional() }),
  ]);
}

const structuralU32 = z.number().int().min(0).max(0xffff_ffff);

export const STRUCTURAL_DIFF_WIRE_VERSION = 3;
export type StructuralDiffEvent =
  | {
      type: "start";
      version: number;
      lhs: StructuralSnapshot;
      rhs: StructuralSnapshot;
      files: StructuralFileChange[];
    }
  | ({
      type: "file";
      file: StructuralPairing<StructuralFileRef>;
      visibility?: StructuralVisibility;
    } & StructuralOutcome)
  | {
      type: "complete";
      succeeded: number;
      failed: number;
      aborted?: StructuralProblem;
    };
export const StructuralDiffEventSchema: z.ZodType<StructuralDiffEvent> = z.lazy(
  () =>
    z.union([
      z.object({
        type: z.literal("start"),
        version: structuralU32,
        lhs: StructuralSnapshotSchema,
        rhs: StructuralSnapshotSchema,
        files: z.array(StructuralFileChangeSchema),
      }),
      z
        .object({
          type: z.literal("file"),
          file: structuralPairingSchema(StructuralFileRefSchema),
          visibility: StructuralVisibilitySchema.optional(),
        })
        .and(StructuralOutcomeSchema),
      z.object({
        type: z.literal("complete"),
        succeeded: structuralU32,
        failed: structuralU32,
        aborted: StructuralProblemSchema.optional(),
      }),
    ]),
);

/** A file record contains exactly one result or error. */
export type StructuralOutcome =
  | { diff: StructuralDiff; error?: never }
  | { error: StructuralProblem; diff?: never };
export const StructuralOutcomeSchema: z.ZodType<StructuralOutcome> = z.lazy(
  () =>
    z.union([
      z.object({ diff: StructuralDiffSchema, error: z.never().optional() }),
      z.object({ error: StructuralProblemSchema, diff: z.never().optional() }),
    ]),
);

export type StructuralSnapshot =
  | { type: "revision"; rev: string }
  | { type: "index" }
  | { type: "working_tree" }
  | { type: "empty_tree" }
  | { type: "path"; path: string };
export const StructuralSnapshotSchema: z.ZodType<StructuralSnapshot> = z.lazy(
  () =>
    z.union([
      z.object({ type: z.literal("revision"), rev: z.string() }),
      z.object({ type: z.literal("index") }),
      z.object({ type: z.literal("working_tree") }),
      z.object({ type: z.literal("empty_tree") }),
      z.object({ type: z.literal("path"), path: z.string() }),
    ]),
);

export type StructuralProblem = { code: string; message: string };
export const StructuralProblemSchema: z.ZodType<StructuralProblem> = z.lazy(
  () => z.object({ code: z.string(), message: z.string() }),
);

export type StructuralFileChange = {
  file: StructuralPairing<StructuralFileRef>;
  status: StructuralFileStatus;
  tags?: string[];
};
export const StructuralFileChangeSchema: z.ZodType<StructuralFileChange> =
  z.lazy(() =>
    z.object({
      file: structuralPairingSchema(StructuralFileRefSchema),
      status: StructuralFileStatusSchema,
      tags: z.array(z.string()).optional(),
    }),
  );

export type StructuralFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "type_changed";
export const StructuralFileStatusSchema: z.ZodType<StructuralFileStatus> =
  z.lazy(() =>
    z.union([
      z.literal("added"),
      z.literal("deleted"),
      z.literal("modified"),
      z.literal("renamed"),
      z.literal("copied"),
      z.literal("type_changed"),
    ]),
  );

export type StructuralFileRef = { path: string; oid: string; mode: string };
export const StructuralFileRefSchema: z.ZodType<StructuralFileRef> = z.lazy(
  () => z.object({ path: z.string(), oid: z.string(), mode: z.string() }),
);

export type StructuralVisibility = { collapsed?: boolean; label?: string };
export const StructuralVisibilitySchema: z.ZodType<StructuralVisibility> =
  z.lazy(() =>
    z.object({
      collapsed: z.boolean().optional(),
      label: z.string().optional(),
    }),
  );

/** Structural changed lines, independent of presentation and fold state. */
export type StructuralChanges = {
  base: [number, number][];
  head: [number, number][];
};

const structuralRangesSchema = z
  .array(z.tuple([structuralU32, structuralU32]))
  .refine(
    (ranges) =>
      ranges.every(
        ([start, end], index) =>
          start < end && (index === 0 || ranges[index - 1][1] < start),
      ),
    "Expected sorted, coalesced, nonempty half-open ranges",
  );

export const StructuralChangesSchema: z.ZodType<StructuralChanges> = z.object({
  base: structuralRangesSchema,
  head: structuralRangesSchema,
});

export function structuralChangeCounts(
  changes: StructuralChanges,
): StructuralLineCounts {
  const count = (ranges: [number, number][]) =>
    ranges.reduce((sum, [start, end]) => sum + end - start, 0);

  return { added: count(changes.head), removed: count(changes.base) };
}

export type StructuralDiff =
  | ({
      type: "text";
      stats: StructuralStats;
      structural_changes: StructuralChanges;
    } & StructuralPairing<StructuralSource>)
  | ({ type: "binary" } & StructuralPairing<StructuralBinaryRef>);
export const StructuralDiffSchema: z.ZodType<StructuralDiff> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal("text"),
        stats: StructuralStatsSchema,
        structural_changes: StructuralChangesSchema,
      })
      .and(structuralPairingSchema(StructuralSourceSchema)),
    z
      .object({ type: z.literal("binary") })
      .and(structuralPairingSchema(StructuralBinaryRefSchema)),
  ]),
);

export type StructuralSource = {
  text: string;
  syntax?: StructuralSyntaxSpan[];
  regions?: StructuralRegion[];
};
export const StructuralSourceSchema: z.ZodType<StructuralSource> = z.lazy(() =>
  z.object({
    text: z.string(),
    syntax: z.array(StructuralSyntaxSpanSchema).optional(),
    regions: z.array(StructuralRegionSchema).optional(),
  }),
);

export type StructuralBinaryRef = { size: number };
export const StructuralBinaryRefSchema: z.ZodType<StructuralBinaryRef> = z.lazy(
  () => z.object({ size: z.number().int().nonnegative() }),
);

export type StructuralSyntaxSpan = {
  line: number;
  start_column: number;
  end_column: number;
  capture: string;
};
export const StructuralSyntaxSpanSchema: z.ZodType<StructuralSyntaxSpan> =
  z.lazy(() =>
    z.object({
      line: structuralU32,
      start_column: structuralU32,
      end_column: structuralU32,
      capture: z.string(),
    }),
  );

/** Region identity, collapse identity, and leaf alignment identity are distinct. */
export type StructuralRegion = {
  id: number;
  fold_state_id: number;
  tags?: string[];
  visibility?: StructuralVisibility;
} & StructuralSourceRange &
  StructuralNode;
export const StructuralRegionSchema: z.ZodType<StructuralRegion> = z.lazy(() =>
  z
    .object({
      id: structuralU32,
      fold_state_id: structuralU32,
      tags: z.array(z.string()).optional(),
      visibility: StructuralVisibilitySchema.optional(),
    })
    .and(StructuralSourceRangeSchema)
    .and(StructuralNodeSchema),
);

export type StructuralNode =
  | { kind: "leaf"; alignment_id: number; changed?: StructuralSpan[] }
  | { kind: "fold"; children: StructuralRegion[] };
export const StructuralNodeSchema: z.ZodType<StructuralNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("leaf"),
      alignment_id: structuralU32,
      changed: z.array(StructuralSpanSchema).optional(),
    }),
    z.object({
      kind: z.literal("fold"),
      children: z.array(StructuralRegionSchema),
    }),
  ]),
);

export type StructuralSpan = {
  line: number;
  start_column: number;
  end_column: number;
};
export const StructuralSpanSchema: z.ZodType<StructuralSpan> = z.lazy(() =>
  z.object({
    line: structuralU32,
    start_column: structuralU32,
    end_column: structuralU32,
  }),
);

export type StructuralSourceRange = {
  start: StructuralPos;
  end: StructuralPos;
};
export const StructuralSourceRangeSchema: z.ZodType<StructuralSourceRange> =
  z.lazy(() =>
    z.object({ start: StructuralPosSchema, end: StructuralPosSchema }),
  );

export type StructuralPos = { line: number; column: number };
export const StructuralPosSchema: z.ZodType<StructuralPos> = z.lazy(() =>
  z.object({
    line: structuralU32,
    column: structuralU32,
  }),
);

export type StructuralStats = {
  textual: StructuralLineCounts;
  visible: StructuralLineCounts;
  fallback?: StructuralProblem;
};
export const StructuralStatsSchema: z.ZodType<StructuralStats> = z.lazy(() =>
  z.object({
    textual: StructuralLineCountsSchema,
    visible: StructuralLineCountsSchema,
    fallback: StructuralProblemSchema.optional(),
  }),
);

export type StructuralLineCounts = { added: number; removed: number };
export const StructuralLineCountsSchema: z.ZodType<StructuralLineCounts> =
  z.lazy(() =>
    z.object({
      added: structuralU32,
      removed: structuralU32,
    }),
  );
