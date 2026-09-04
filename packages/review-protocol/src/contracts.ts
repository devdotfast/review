import { z } from "zod";

import { type JsonValue, isJsonObject } from "./json.js";

export const sessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const byCommitSchema = z.object({
  commit: commitShaSchema,
  sessions: z.array(sessionIdSchema),
  repo: z.string(),
  pr: z.number().int().nullable(),
  branch: z.string().nullable(),
  indexed_by: z.enum(["hook", "ci"]),
  ts: z.string(),
});
export type ByCommitEntry = z.infer<typeof byCommitSchema>;

export const sessionMetaSchema = z.object({
  session: sessionIdSchema,
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  pr: z.number().int().nullable(),
  commits: z.array(commitShaSchema),
  author: z.string().nullable(),
  ts: z.string(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

// Version 3: `review publish` owns validation, bundling, and sealing; the
// desktop serves prebuilt revisions and exposes /publish-ready instead of the
// removed /publish route. (Version 2 added the bundled-CLI discovery fields.)
export const REVIEW_DESKTOP_DISCOVERY_VERSION = 3;
export const REVIEW_SCHEMA_VERSION = 4;

const requiredString = z
  .string({ error: "must be a string" })
  .refine((value) => value.trim().length > 0, "must be a string");
const stringAllowEmpty = z.string({ error: "must be a string" });
const positiveInteger = z
  .number({ error: "must be a positive integer" })
  .int("must be a positive integer")
  .positive("must be a positive integer");
const nonNegativeInteger = z
  .number({ error: "must be a non-negative integer" })
  .int("must be a non-negative integer")
  .nonnegative("must be a non-negative integer");
const reviewDiffSideSchema = z.enum(["base", "head"], {
  error: "must be base or head",
});
export const reviewViewSchema = z.enum([
  "review",
  "commits",
  "diff",
  "map",
  "trace",
]);
export type ReviewView = z.infer<typeof reviewViewSchema>;
const reviewThemeSchema = z.enum(["light", "dark"], {
  error: "must be light or dark",
});

function urlSchema(
  output: "href" | "origin",
  constraint?: (url: URL) => string | null,
) {
  return requiredString.transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "must be an absolute URL",
      });
      return z.NEVER;
    }
    const error = constraint?.(url);
    if (error) {
      context.addIssue({ code: "custom", message: error });
      return z.NEVER;
    }
    return output === "origin" ? url.origin : url.href;
  });
}

const absoluteUrlSchema = urlSchema("href");
const loopbackUrlSchema = urlSchema("href", (url) =>
  url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    ? null
    : "must use http://127.0.0.1:<port>",
).transform((value) => value.replace(/\/$/, ""));
const loopbackOriginSchema = urlSchema("origin", (url) =>
  url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    ? null
    : "must use http://127.0.0.1:<port>",
);

export function normalizeReviewRoutePath(pathname: string): string {
  const pathnameOnly = String(pathname || "/").split(/[?#]/)[0] || "/";
  let end = pathnameOnly.length;
  while (end > 1 && pathnameOnly.charCodeAt(end - 1) === 47) end--;
  const trimmed = pathnameOnly.slice(0, end) || "/";
  return trimmed === "/"
    ? "/"
    : trimmed.startsWith("/")
      ? trimmed
      : `/${trimmed}`;
}

const routePathSchema = requiredString.transform(normalizeReviewRoutePath);

export const ReviewRuntimeConfigSchema = z.strictObject({
  serverUrl: loopbackOriginSchema,
  sessionUrl: loopbackUrlSchema,
  routePath: routePathSchema,
  sessionId: requiredString,
  token: stringAllowEmpty,
  wasmUrl: absoluteUrlSchema,
  docRuntimeUrl: absoluteUrlSchema,
  appVersion: requiredString.max(100),
  theme: reviewThemeSchema,
  host: z.literal("desktop"),
});
export type ReviewRuntimeConfig = z.infer<typeof ReviewRuntimeConfigSchema>;
export type ReviewHost = ReviewRuntimeConfig["host"];
export type ReviewTheme = ReviewRuntimeConfig["theme"];
export type ReviewDiffSide = z.infer<typeof reviewDiffSideSchema>;

export interface ReviewDisposable {
  dispose(): void;
}

const threadTargetNonEmptyStringSchema = z
  .string({ error: "must be a non-empty string" })
  .min(1, "must be a non-empty string");
const threadTargetNonNegativeIntegerSchema = z.coerce
  .number({ error: "must be a non-negative integer" })
  .int("must be a non-negative integer")
  .nonnegative("must be a non-negative integer");
const threadTargetPositiveIntegerSchema = z.coerce
  .number({ error: "must be a positive integer" })
  .int("must be a positive integer")
  .positive("must be a positive integer");

const ThreadSelectionSchema = z.strictObject({
  start: threadTargetNonNegativeIntegerSchema,
  length: threadTargetPositiveIntegerSchema,
  hash: threadTargetNonEmptyStringSchema,
  quote: threadTargetNonEmptyStringSchema,
});
export type ThreadSelection = z.infer<typeof ThreadSelectionSchema>;

const TextSurfaceSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({
      type: z.literal("document"),
      documentHash: threadTargetNonEmptyStringSchema,
    }),
    z.strictObject({
      type: z.literal("block"),
      tag: threadTargetNonEmptyStringSchema,
      index: threadTargetNonNegativeIntegerSchema,
      blockHash: threadTargetNonEmptyStringSchema,
    }),
    z.strictObject({
      type: z.literal("table-cell"),
      table: threadTargetNonNegativeIntegerSchema,
      row: threadTargetNonNegativeIntegerSchema,
      column: threadTargetNonNegativeIntegerSchema,
    }),
    z.strictObject({
      type: z.literal("anchor"),
      anchorId: threadTargetNonEmptyStringSchema,
      part: z.strictObject({
        type: z.literal("text"),
        field: z.enum(["title", "detail"], {
          error: "must be title or detail",
        }),
      }),
    }),
  ],
  "must be document, block, table-cell, or anchor",
);
export type TextSurface = z.infer<typeof TextSurfaceSchema>;

const gitLabPositionNullableString = (maxLength: number) =>
  z.string().max(maxLength).nullable().optional();
const gitLabPositionNullableInteger = z.number().int().nullable().optional();

export const GitLabDiffLinePositionSchema = z.strictObject({
  // Identifies one rendered diff row as <SHA1(path)>_<old line>_<new line>.
  line_code: z.string().max(100),
  // Selects which side owns the range boundary. Unchanged rows use null.
  type: z.enum(["old", "new"]).nullable(),
  old_line: gitLabPositionNullableInteger,
  new_line: gitLabPositionNullableInteger,
});
export type GitLabDiffLinePosition = z.infer<
  typeof GitLabDiffLinePositionSchema
>;

export const GitLabDiffPositionSchema = z.strictObject({
  base_sha: gitLabPositionNullableString(64),
  start_sha: gitLabPositionNullableString(64),
  head_sha: gitLabPositionNullableString(64),
  // Identifies the diff file when paths alone are ambiguous.
  file_identifier_hash: gitLabPositionNullableString(40),
  old_path: gitLabPositionNullableString(1000),
  new_path: gitLabPositionNullableString(1000),
  position_type: z.enum(["text", "image", "file"]).nullable().optional(),
  old_line: gitLabPositionNullableInteger,
  new_line: gitLabPositionNullableInteger,
  line_range: z
    .strictObject({
      start: GitLabDiffLinePositionSchema,
      end: GitLabDiffLinePositionSchema,
    })
    .nullable()
    .optional(),
  // These fields support image comments.
  width: z
    .union([z.number().int(), z.string().max(10)])
    .nullable()
    .optional(),
  height: z
    .union([z.number().int(), z.string().max(10)])
    .nullable()
    .optional(),
  x: z
    .union([z.number().int(), z.string().max(10)])
    .nullable()
    .optional(),
  y: z
    .union([z.number().int(), z.string().max(10)])
    .nullable()
    .optional(),
  ignore_whitespace_change: z.boolean().nullable().optional(),
});
export type GitLabDiffPosition = z.infer<typeof GitLabDiffPositionSchema>;

export interface GitLabTextDiffRow {
  old_line: number | null;
  new_line: number | null;
}

export interface CreateGitLabTextDiffPositionInput {
  base_sha: string | null;
  start_sha: string;
  head_sha: string;
  old_path: string | null;
  new_path: string | null;
  file_path_hash?: string;
  file_identifier_hash?: string | null;
  start: GitLabTextDiffRow;
  end: GitLabTextDiffRow;
  ignore_whitespace_change?: boolean;
}

export function createGitLabTextDiffPosition(
  input: CreateGitLabTextDiffPositionInput,
): GitLabDiffPosition {
  const path = input.new_path ?? input.old_path;
  if (!path) throw new Error("A GitLab diff position must have a file path.");
  const filePathHash = input.file_path_hash ?? gitLabLineCodePathHash(path);
  const start = gitLabDiffLinePosition(filePathHash, input.start);
  const end = gitLabDiffLinePosition(filePathHash, input.end);
  return {
    base_sha: input.base_sha,
    start_sha: input.start_sha,
    head_sha: input.head_sha,
    file_identifier_hash: input.file_identifier_hash ?? null,
    old_path: input.old_path,
    new_path: input.new_path,
    position_type: "text",
    old_line: input.end.old_line,
    new_line: input.end.new_line,
    line_range: { start, end },
    ignore_whitespace_change: input.ignore_whitespace_change ?? false,
  };
}

export function gitLabLineCodePathHash(value: string): string {
  const source = new TextEncoder().encode(value);
  const length = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = source.length * 8;
  view.setUint32(length - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(length - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3]! ^
          words[index - 8]! ^
          words[index - 14]! ^
          words[index - 16]!,
        1,
      );
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      const group = Math.floor(index / 20);
      const f =
        group === 0
          ? (b & c) | (~b & d)
          : group === 2
            ? (b & c) | (b & d) | (c & d)
            : b ^ c ^ d;
      const k = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6][group]!;
      const next = (rotateLeft(a, 5) + f + e + k + words[index]!) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

export function gitLabDiffPositionPath(
  position: GitLabDiffPosition,
): string | null {
  return position.new_path ?? position.old_path ?? null;
}

export function gitLabDiffPositionRows(
  position: GitLabDiffPosition,
): { start: GitLabTextDiffRow; end: GitLabTextDiffRow } | null {
  if (position.position_type !== "text") return null;
  if (position.line_range) {
    return {
      start: {
        old_line: position.line_range.start.old_line ?? null,
        new_line: position.line_range.start.new_line ?? null,
      },
      end: {
        old_line: position.line_range.end.old_line ?? null,
        new_line: position.line_range.end.new_line ?? null,
      },
    };
  }
  const row = {
    old_line: position.old_line ?? null,
    new_line: position.new_line ?? null,
  };
  return row.old_line === null && row.new_line === null
    ? null
    : { start: row, end: row };
}

function gitLabDiffLinePosition(
  filePathHash: string,
  row: GitLabTextDiffRow,
): GitLabDiffLinePosition {
  if (row.old_line === null && row.new_line === null) {
    throw new Error("A GitLab text diff row must have an old or new line.");
  }
  return {
    line_code: `${filePathHash}_${row.old_line ?? 0}_${row.new_line ?? 0}`,
    type:
      row.old_line !== null && row.new_line !== null
        ? null
        : row.new_line !== null
          ? "new"
          : "old",
    old_line: row.old_line,
    new_line: row.new_line,
  };
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export const CodeThreadTargetSchema = z
  .strictObject({
    kind: z.literal("code"),
    original_position: GitLabDiffPositionSchema,
    position: GitLabDiffPositionSchema,
    change_position: GitLabDiffPositionSchema.optional(),
  })
  .superRefine((target, context) => {
    for (const key of ["original_position", "position"] as const) {
      if (!isCompleteReviewCodePosition(target[key])) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must be a complete text diff position",
        });
      }
    }
    if (
      target.change_position &&
      !isCompleteReviewCodePosition(target.change_position)
    ) {
      context.addIssue({
        code: "custom",
        path: ["change_position"],
        message: "must be a complete text diff position",
      });
    }
  });
export type CodeThreadTarget = z.infer<typeof CodeThreadTargetSchema>;

export const ThreadTargetSchema = z.discriminatedUnion(
  "kind",
  [
    // Historical document targets can contain ignored surface and selection keys.
    z.object({ kind: z.literal("document") }),
    CodeThreadTargetSchema,
    z.strictObject({
      kind: z.literal("text"),
      surface: TextSurfaceSchema,
      selection: ThreadSelectionSchema,
    }),
    z.strictObject({
      kind: z.literal("graph"),
      diagram: threadTargetNonEmptyStringSchema,
      element: z.strictObject({
        type: z.enum(["node", "edge"], {
          error: "type must be node or edge",
        }),
        path: z
          .array(threadTargetNonEmptyStringSchema)
          .min(1, "must be a non-empty array"),
        hash: threadTargetNonEmptyStringSchema,
        quote: threadTargetNonEmptyStringSchema,
      }),
    }),
  ],
  "must be document, code, text, or graph",
);
export type ThreadTarget = z.infer<typeof ThreadTargetSchema>;

export const CreateReviewCommentInputSchema = z.strictObject({
  threadId: threadTargetNonEmptyStringSchema,
  messageId: threadTargetNonEmptyStringSchema,
  target: ThreadTargetSchema,
  body: threadTargetNonEmptyStringSchema,
  agentInput: z.boolean().optional(),
});
export type CreateReviewCommentInput = z.infer<
  typeof CreateReviewCommentInputSchema
>;

export const ReviewCommentAgentSessionSchema = z.strictObject({
  harness: z.enum(["codex", "claude-code", "pi"]),
  sessionId: threadTargetNonEmptyStringSchema,
});
export type ReviewCommentAgentSession = z.infer<
  typeof ReviewCommentAgentSessionSchema
>;

export const ReviewCommentThreadRecordSchema = z.strictObject({
  threadId: threadTargetNonEmptyStringSchema,
  target: ThreadTargetSchema,
  status: z.enum(["open", "resolved"]),
  agentSession: ReviewCommentAgentSessionSchema.optional(),
  messages: z.array(
    z.strictObject({
      id: threadTargetNonEmptyStringSchema,
      by: threadTargetNonEmptyStringSchema,
      at: threadTargetNonEmptyStringSchema,
      body: z.string(),
      role: z.enum(["reviewer", "agent"]).optional(),
      format: z.enum(["plain", "markdown"]).optional(),
      agentInput: z.boolean().default(false),
    }),
  ),
});
export type ReviewCommentThreadRecord = z.infer<
  typeof ReviewCommentThreadRecordSchema
>;
export type ReviewCommentMessage =
  ReviewCommentThreadRecord["messages"][number];

function isCompleteReviewCodePosition(position: GitLabDiffPosition): boolean {
  return (
    position.position_type === "text" &&
    Boolean(position.start_sha) &&
    Boolean(position.head_sha) &&
    Boolean(position.old_path || position.new_path) &&
    (position.old_line !== null && position.old_line !== undefined
      ? position.old_line > 0
      : position.new_line !== null &&
        position.new_line !== undefined &&
        position.new_line > 0)
  );
}

export const ReviewCommentThreadMapSchema = z
  .record(threadTargetNonEmptyStringSchema, ReviewCommentThreadRecordSchema)
  .superRefine((comments, context) => {
    for (const [threadId, comment] of Object.entries(comments)) {
      if (comment.threadId !== threadId) {
        context.addIssue({
          code: "custom",
          path: [threadId, "threadId"],
          message: "must match the storage key",
        });
      }
    }
  });
export type ReviewCommentThreadMap = z.infer<
  typeof ReviewCommentThreadMapSchema
>;

export const ReviewCommentDraftThreadSchema = z.strictObject({
  thread: ReviewCommentThreadRecordSchema,
  inputs: z.array(CreateReviewCommentInputSchema).min(1),
});
export type ReviewCommentDraftThread = z.infer<
  typeof ReviewCommentDraftThreadSchema
>;

export const ReviewCommentDraftThreadMapSchema = z
  .record(threadTargetNonEmptyStringSchema, ReviewCommentDraftThreadSchema)
  .superRefine((drafts, context) => {
    for (const [threadId, draft] of Object.entries(drafts)) {
      if (draft.thread.threadId !== threadId) {
        context.addIssue({
          code: "custom",
          path: [threadId, "thread", "threadId"],
          message: "must match the storage key",
        });
      }
      for (const [index, input] of draft.inputs.entries()) {
        if (input.threadId !== threadId) {
          context.addIssue({
            code: "custom",
            path: [threadId, "inputs", index, "threadId"],
            message: "must match the storage key",
          });
        }
      }
    }
  });
export type ReviewCommentDraftThreadMap = z.infer<
  typeof ReviewCommentDraftThreadMapSchema
>;

export function parseStoredReviewCommentThreadMap(
  value: JsonValue,
): ReviewCommentThreadMap {
  return ReviewCommentThreadMapSchema.parse(value);
}

export function parseReviewCommentThreadMap(
  value: JsonValue,
): ReviewCommentThreadMap {
  if (!isJsonObject(value)) return {};
  const comments: ReviewCommentThreadMap = {};
  for (const [threadId, candidate] of Object.entries(value)) {
    const parsed = ReviewCommentThreadRecordSchema.safeParse(candidate);
    if (parsed.success && parsed.data.threadId === threadId) {
      comments[threadId] = parsed.data;
    }
  }
  return comments;
}

export const ReviewThreadsSnapshotSchema = z.strictObject({
  revision: threadTargetNonNegativeIntegerSchema,
  comments: ReviewCommentThreadMapSchema,
  drafts: ReviewCommentDraftThreadMapSchema,
});
export type ReviewThreadsSnapshot = z.infer<typeof ReviewThreadsSnapshotSchema>;

export const ReviewThreadsCommitSchema = z.strictObject({
  mutationId: threadTargetNonEmptyStringSchema,
  revision: threadTargetNonNegativeIntegerSchema,
  upsertedThreads: z.array(ReviewCommentThreadRecordSchema),
  deletedThreadIds: z.array(threadTargetNonEmptyStringSchema),
  upsertedDrafts: z.array(
    z.strictObject({
      threadId: threadTargetNonEmptyStringSchema,
      draft: ReviewCommentDraftThreadSchema,
    }),
  ),
  deletedDraftThreadIds: z.array(threadTargetNonEmptyStringSchema),
});
export type ReviewThreadsCommit = z.infer<typeof ReviewThreadsCommitSchema>;

const ReviewCommentUpdateSchema = z.strictObject({
  status: z.enum(["open", "resolved"]).optional(),
  body: z.string().optional(),
  messageId: threadTargetNonEmptyStringSchema.optional(),
});

export const ReviewThreadsCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("comment.create"),
    mutationId: threadTargetNonEmptyStringSchema,
    input: CreateReviewCommentInputSchema,
  }),
  z.strictObject({
    command: z.literal("comment.update"),
    mutationId: threadTargetNonEmptyStringSchema,
    threadId: threadTargetNonEmptyStringSchema,
    update: ReviewCommentUpdateSchema,
  }),
  z.strictObject({
    command: z.literal("comment.delete"),
    mutationId: threadTargetNonEmptyStringSchema,
    threadId: threadTargetNonEmptyStringSchema,
  }),
  z.strictObject({
    command: z.literal("comment-message.delete"),
    mutationId: threadTargetNonEmptyStringSchema,
    threadId: threadTargetNonEmptyStringSchema,
    messageId: threadTargetNonEmptyStringSchema,
  }),
  z.strictObject({
    command: z.literal("comment-draft.create"),
    mutationId: threadTargetNonEmptyStringSchema,
    input: CreateReviewCommentInputSchema,
  }),
  z.strictObject({
    command: z.literal("comment-draft.update"),
    mutationId: threadTargetNonEmptyStringSchema,
    threadId: threadTargetNonEmptyStringSchema,
    update: ReviewCommentUpdateSchema,
  }),
  z.strictObject({
    command: z.literal("comment-draft.delete"),
    mutationId: threadTargetNonEmptyStringSchema,
    threadId: threadTargetNonEmptyStringSchema,
  }),
  z.strictObject({
    command: z.literal("comment-draft-message.delete"),
    mutationId: threadTargetNonEmptyStringSchema,
    threadId: threadTargetNonEmptyStringSchema,
    messageId: threadTargetNonEmptyStringSchema,
  }),
]);
export type ReviewThreadsCommand = z.infer<typeof ReviewThreadsCommandSchema>;

const reviewNodeIdSchema = z
  .string({ error: "must be a stable node ID" })
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/, "must be a stable node ID");

export const ReviewDocumentNodeSchema = z.strictObject({
  id: reviewNodeIdSchema,
  kind: z.enum(["markdown", "callout", "code"]),
  content: z.string(),
  title: z.string().optional(),
  tone: z.enum(["info", "warning", "success", "danger"]).optional(),
  language: z.string().optional(),
});
export type ReviewDocumentNode = z.infer<typeof ReviewDocumentNodeSchema>;

export const ReviewDocumentSnapshotSchema = z.strictObject({
  reviewId: z.uuid({ error: "must be a UUID" }),
  routePath: routePathSchema,
  mode: z.enum(["compiled", "incremental"]),
  revision: nonNegativeInteger,
  sourceHash: requiredString,
  source: z.string(),
  nodes: z.array(ReviewDocumentNodeSchema).nullable(),
});
export type ReviewDocumentSnapshot = z.infer<
  typeof ReviewDocumentSnapshotSchema
>;

// Rich MDX authoring exposes only its two authored inputs, never arbitrary paths.
export const ReviewDocumentFileNameSchema = z.enum(["review.mdx", "data.ts"]);
export type ReviewDocumentFileName = z.infer<
  typeof ReviewDocumentFileNameSchema
>;
export const ReviewDocumentFileSchema = z.strictObject({
  name: ReviewDocumentFileNameSchema,
  source: z.string().nullable(),
  sourceHash: requiredString.nullable(),
});
export type ReviewDocumentFile = z.infer<typeof ReviewDocumentFileSchema>;
export const ReviewDocumentFileWriteSchema = z.strictObject({
  source: z.string(),
  expectedSourceHash: requiredString.nullable(),
});
export type ReviewDocumentFileWrite = z.infer<
  typeof ReviewDocumentFileWriteSchema
>;

const ReviewDocumentNodePatchSchema = z
  .strictObject({
    kind: ReviewDocumentNodeSchema.shape.kind.optional(),
    content: z.string().optional(),
    title: z.string().nullable().optional(),
    tone: ReviewDocumentNodeSchema.shape.tone.nullable().optional(),
    language: z.string().nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "must not be empty");

export const ReviewDocumentOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("replace"),
    nodes: z.array(ReviewDocumentNodeSchema),
  }),
  z.strictObject({
    type: z.literal("insert"),
    index: nonNegativeInteger,
    node: ReviewDocumentNodeSchema,
  }),
  z.strictObject({
    type: z.literal("update"),
    nodeId: reviewNodeIdSchema,
    patch: ReviewDocumentNodePatchSchema,
  }),
  z.strictObject({
    type: z.literal("delete"),
    nodeId: reviewNodeIdSchema,
  }),
  z.strictObject({
    type: z.literal("move"),
    nodeId: reviewNodeIdSchema,
    index: nonNegativeInteger,
  }),
]);
export type ReviewDocumentOperation = z.infer<
  typeof ReviewDocumentOperationSchema
>;

export const ReviewDocumentMutationRequestSchema = z.strictObject({
  mutationId: threadTargetNonEmptyStringSchema,
  expectedRevision: nonNegativeInteger,
  expectedSourceHash: requiredString.optional(),
  operation: ReviewDocumentOperationSchema,
});
export type ReviewDocumentMutationRequest = z.infer<
  typeof ReviewDocumentMutationRequestSchema
>;

export interface ReviewLocalCommentThread {
  clientStatus: "draft" | "submitting";
  thread: ReviewCommentThreadRecord;
  inputs: CreateReviewCommentInput[];
}

export type ReviewCommentAgentActivity =
  | {
      messageId: string;
      startedAt: string;
      status: "starting" | "running";
    }
  | {
      messageId: string;
      startedAt: string;
      status: "failed";
      error: string;
    };

export interface ReviewCommentStoreSnapshot {
  commentThreads: ReadonlyMap<string, ReviewCommentThreadRecord>;
  localComments: ReadonlyMap<string, ReviewLocalCommentThread>;
  agentActivities: ReadonlyMap<string, ReviewCommentAgentActivity>;
  pendingCommentCount: number;
}

export interface ReviewCommentStoreChange {
  threadIds: ReadonlySet<string>;
}

export interface ReviewCommentStoreBridge {
  subscribe(listener: (change: ReviewCommentStoreChange) => void): () => void;
  getSnapshot(): ReviewCommentStoreSnapshot;
  saveComment(input: CreateReviewCommentInput): Promise<void>;
  askAgent(input: CreateReviewCommentInput): Promise<void>;
  deleteLocalComment(threadId: string): Promise<void>;
  updateComment(
    threadId: string,
    body: string,
    messageId?: string,
  ): Promise<void>;
  deleteComment(threadId: string): Promise<void>;
  deleteCommentMessage(threadId: string, messageId: string): Promise<void>;
  setCommentResolved(threadId: string, resolved: boolean): Promise<void>;
  flushPendingComments(): Promise<CreateReviewCommentInput[]>;
  persistComment(input: CreateReviewCommentInput): Promise<void>;
  resetPendingComments(): void;
  completeHumanReviewRound(): void;
}

export type ReviewInlineEditorHeightMode = "capped" | "content";

export interface ReviewInlineEditorRange {
  startLine: number;
  endLine: number;
  side?: ReviewDiffSide;
}

export interface ReviewInlineEditorSpec {
  container: HTMLElement;
  path: string;
  title: string;
  description?: string;
  side: ReviewDiffSide;
  ranges: readonly ReviewInlineEditorRange[];
  heightMode: ReviewInlineEditorHeightMode;
  active: boolean;
  diffStats?: {
    additions: number;
    deletions: number;
  };
  onDidFocus?: () => void;
  onDidOpen?: () => void;
  onDidNavigate?: () => void;
  onDidShowHover?: () => void;
  commentsEnabled?: boolean;
}

export interface ReviewFindQuery {
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

export interface ReviewInlineFindResult {
  matchCount: number;
}

export interface ReviewInlineFindSpec {
  path: string;
  side: ReviewDiffSide;
  ranges: readonly ReviewInlineEditorRange[];
  commentsEnabled?: boolean;
}

export interface ReviewInlineEditorHandle extends ReviewDisposable {
  readonly height: number;
  setActive(active: boolean): void;
  setCollapsed(collapsed: boolean): void;
  onDidChangeHeight(listener: (height: number) => void): ReviewDisposable;
  onDidError(listener: (message: string) => void): ReviewDisposable;
  setFindQuery(query: ReviewFindQuery): Promise<ReviewInlineFindResult>;
  revealFindMatch(index: number): void;
  clearActiveFindMatch(): void;
  clearFind(): void;
}

export interface ReviewInlineEditorFactory {
  create(spec: ReviewInlineEditorSpec): ReviewInlineEditorHandle;
  find(
    spec: ReviewInlineFindSpec,
    query: ReviewFindQuery,
  ): Promise<ReviewInlineFindResult>;
}

export interface ReviewDiffViewSpec {
  container: HTMLElement;
  scope?: ReviewCommitScope;
}

export interface ReviewDiffViewHandle extends ReviewDisposable {
  focus(): void;
  onDidError(listener: (message: string) => void): ReviewDisposable;
}

/**
 * Mounts the changed-files diff UI — file list and multi-diff widget — into an
 * app-owned container. `create` returns at once and initializes the widget
 * asynchronously; a failed initialization arrives through `onDidError`.
 */
export interface ReviewDiffViewFactory {
  create(spec: ReviewDiffViewSpec): ReviewDiffViewHandle;
  /** Returns the parsed full diff that backs the native diff view. */
  files?(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]>;
}

export interface ReviewCommitScope {
  commit: string;
}

export interface ReviewCanvasDiagnostic {
  level: "error" | "warning";
  source: string;
  message: string;
  stack?: string;
}

export interface ReviewCanvasBridge {
  readonly appSessionId?: string;
  readonly config: ReviewRuntimeConfig;
  readonly comments: ReviewCommentStoreBridge;
  readonly inlineEditors: ReviewInlineEditorFactory;
  readonly diffView: ReviewDiffViewFactory;
  request(url: string, init?: RequestInit): Promise<Response>;
  post(request: ReviewVerbRequest): Promise<ReviewVerbResponse>;
  subscribe(listener: (event: ReviewSurfaceEvent) => void): ReviewDisposable;
  currentTheme(): ReviewTheme;
  onDidChangeTheme(listener: (theme: ReviewTheme) => void): ReviewDisposable;
  ready(): void;
  reportDiagnostic?(diagnostic: ReviewCanvasDiagnostic): void;
}

/**
 * Install state and actions the workbench hands to the Home canvas. `apply`,
 * `skip`, and `enablePrompts` resolve with the refreshed status so the card can
 * re-render without a full canvas update.
 */
export interface ReviewCanvasInstallContent {
  status: ReviewCliInstallStatus;
  apply(request: {
    targets: readonly ReviewCliInstallTarget[];
    shim?: boolean;
    fff?: boolean;
    trace?:
      | true
      | {
          endpoint?: string;
          bucket?: string;
          region?: string;
          key?: string;
          secret?: string;
        };
  }): Promise<ReviewCliInstallStatus>;
  remove(request: {
    targets: readonly ReviewCliInstallTarget[];
    shim?: boolean;
    fff?: boolean;
    trace?: true;
  }): Promise<ReviewCliInstallStatus>;
  decline(): Promise<ReviewCliInstallStatus>;
  skip(): Promise<ReviewCliInstallStatus>;
  enablePrompts(): Promise<ReviewCliInstallStatus>;
}

/**
 * Install status handed to the Home canvas so it can show a one-line setup
 * banner when the install needs attention. `open` navigates to the Agent
 * Setup page.
 */
export interface ReviewCanvasHomeSetup {
  status: ReviewCliInstallStatus;
  open(): void;
}

/**
 * Onboarding progress for the Welcome pane: which of the three steps the user
 * finished. `tutorialChecked` counts the checklist steps the tutorial
 * recorded, out of `tutorialTotal`.
 */
export interface ReviewCanvasOnboarding {
  installed: boolean;
  tutorialChecked: number;
  tutorialTotal: number;
  // At least one published review exists. Drafts and the tutorial are not in
  // the review list, so this only counts a real published review.
  published: boolean;
}

// The workbench owns the theme and the keymap; the canvas only names a choice.
// Both lists mirror the workbench side (`reviewThemeChoice.ts` and
// `REVIEW_KEYMAPS` in `reviewConfigurationDefaults.ts`).
export const REVIEW_THEME_CHOICES = ["dark", "light", "system"] as const;
export type ReviewThemeChoice = (typeof REVIEW_THEME_CHOICES)[number];

export const REVIEW_KEYMAP_CHOICES = ["none", "vim", "emacs"] as const;
export type ReviewKeymapChoice = (typeof REVIEW_KEYMAP_CHOICES)[number];

export const REVIEW_TUTORIAL_STEP_IDS = [
  "openPeek",
  "gotoDefinition",
  "showHover",
  "openCommits",
  "openDiff",
  "leaveComment",
  "openSequence",
  "openMap",
  "openDatabase",
  "getHelp",
  "chooseKeymap",
] as const;
export type TutorialStepId = (typeof REVIEW_TUTORIAL_STEP_IDS)[number];
export const REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY =
  "review.tutorial.progress.v1";

export interface TutorialProgressV1 {
  version: 1;
  checked: TutorialStepId[];
  dismissed: boolean;
}

export interface ReviewCanvasTutorialContent {
  reviewUuid: string;
  progress: TutorialProgressV1;
  keymap: ReviewKeymapChoice;
}

export interface ReviewCanvasTutorialBridge {
  content: ReviewCanvasTutorialContent;
  setStep(step: TutorialStepId, checked: boolean): void;
  dismiss(): void;
  reopen(): void;
  selectKeymap(keymap: ReviewKeymapChoice): Promise<void>;
  // Closes the tutorial tab. The tutorial is not in the review store, so
  // there is nothing to dismiss — finishing it just means closing it.
  close(): void;
}

/**
 * How long a dismissed review waits before the reaper deletes it. The server
 * owns the stored value, but the workbench needs the same default so the
 * Settings page can still show a truthful row when the read fails.
 */
export const DEFAULT_DISMISSED_RETENTION_DAYS = 30;

/**
 * Settings state and actions the workbench hands to the Settings canvas. Every
 * setter resolves with the value that actually landed, so a row re-renders from
 * the authoritative result instead of an optimistic one.
 */
export interface ReviewCanvasSettingsContent {
  // Backed by the `review.telemetry.enabled` workbench setting, which the
  // review server and the CLI both read.
  telemetryEnabled: boolean;
  setTelemetryEnabled(enabled: boolean): Promise<boolean>;
  theme: ReviewThemeChoice;
  setTheme(choice: ReviewThemeChoice): Promise<ReviewThemeChoice>;
  keymap: ReviewKeymapChoice;
  // A keymap only takes effect after the extension host restarts, so the
  // workbench offers the window reload. The page never forces one.
  setKeymap(choice: ReviewKeymapChoice): Promise<ReviewKeymapChoice>;
  // The one value here that is not a workbench setting. The reaper runs inside
  // the review server, which never reads workbench configuration, so this lives
  // in the server preferences file. `null` turns reaping off.
  dismissedRetentionDays: number | null;
  setDismissedRetentionDays(days: number | null): Promise<number | null>;
  softwareMapEnabled: boolean;
  setSoftwareMapEnabled(enabled: boolean): Promise<boolean>;
  manageExtensions(): void;
  // Agent installs are managed here too, so they stay reachable once Home
  // has reviews and no longer shows the Welcome rail. Absent when the
  // install status endpoint is unavailable.
  install?: ReviewCanvasInstallContent;
}

/**
 * A host-owned, read-only projection of the current incremental document.
 * The canvas subscribes to this bridge instead of performing network or
 * filesystem I/O itself.
 */
export interface ReviewDocumentStoreBridge {
  getSnapshot(): ReviewDocumentSnapshot;
  subscribe(listener: () => void): ReviewDisposable;
}

export type ReviewCanvasDocument =
  | { kind: "compiled"; bundle: unknown }
  | { kind: "incremental"; store: ReviewDocumentStoreBridge };

export type ReviewCanvasContent =
  | { kind: "loading" }
  | {
      kind: "error";
      message: string;
      reviewErrors?: readonly ReviewListError[];
    }
  // The Source tab: an empty state beside the read-only file tree. Static —
  // the tree and the file tabs it opens are native surfaces. `error` is set
  // when the worktree cannot be browsed (deleted checkout, unavailable
  // session) and carries the human-readable reason.
  | { kind: "source"; error?: string }
  | {
      kind: "home";
      reviews: readonly ReviewDescriptor[];
      reviewErrors: readonly ReviewListError[];
      openReview(uuid: string): void;
      // Deletes the review and closes its canvas. Absent when the host does
      // not support deletion.
      deleteReview?(uuid: string): Promise<void>;
      // Dismissal is reversible: it stamps the review and starts the reap
      // clock. Deletion is immediate and permanent. Absent when the host does
      // not support them.
      dismissReview?(uuid: string): Promise<void>;
      restoreReview?(uuid: string): Promise<void>;
      // Opens the review and pins its read-only source tree open. Absent when
      // the host cannot show the tree.
      openSourceTree?(uuid: string): void;
      // Absent when the install status endpoint is unavailable.
      setup?: ReviewCanvasHomeSetup;
      // With no reviews, Home renders the Welcome rail instead of a zero
      // state of its own, so it needs what Welcome needs. Both absent when
      // the install status endpoint is unavailable.
      install?: ReviewCanvasInstallContent;
      onboarding?: ReviewCanvasOnboarding;
      // Opens the tutorial tab. Never gated on install status: the tutorial
      // needs no agent.
      openTutorial(): void;
    }
  | {
      kind: "welcome";
      // Absent when the install status endpoint is unavailable.
      install?: ReviewCanvasInstallContent;
      // Closes the Welcome tab ("Skip for now" on first run).
      close?(): void;
      // Drives the step rail. Absent when the install status is unavailable.
      onboarding?: ReviewCanvasOnboarding;
      // Opens the tutorial tab. Never gated on install status: the tutorial
      // needs no agent.
      openTutorial(): void;
    }
  | {
      kind: "settings";
      settings: ReviewCanvasSettingsContent;
    }
  | {
      kind: "completed";
      reviewPath?: string;
      showHome(): void;
    }
  | {
      kind: "session";
      bridge: ReviewCanvasBridge;
      document: Promise<ReviewCanvasDocument>;
      softwareMap: Promise<unknown | null>;
      softwareMapEnabled: boolean;
      reviewErrors: readonly ReviewListError[];
      range: ReviewCanvasRange;
      commits: readonly ReviewCommitSummary[];
      tutorial?: ReviewCanvasTutorialBridge;
    };

export interface ReviewCanvasRange {
  baseRef: string;
  headRef: string;
  baseCommit: string;
  headCommit: string;
}

export interface ReviewCanvasHandle extends ReviewDisposable {
  update(content: ReviewCanvasContent): void;
  focus(): void;
  showFind(seed?: string): boolean;
}

export const REVIEW_CANVAS_RESUME_EVENT = "dev-fast-review-canvas-resume";

export interface ReviewCanvasModule {
  mountReviewCanvas(
    container: HTMLElement,
    content: ReviewCanvasContent,
  ): ReviewCanvasHandle;
}

// Tolerant of unknown keys so future additive fields never force a version
// bump; readers must ignore fields they do not understand.
export const ReviewDesktopDiscoverySchema = z.object({
  version: z.literal(REVIEW_DESKTOP_DISCOVERY_VERSION, {
    error: "Unsupported Review Desktop discovery version",
  }),
  instanceId: requiredString,
  url: loopbackOriginSchema,
  appPid: positiveInteger,
  serverPid: positiveInteger,
  token: requiredString,
  startedAt: positiveInteger,
  cliPath: requiredString.optional(),
  cliVersion: requiredString.optional(),
  // An executable that behaves as Node.js when ELECTRON_RUN_AS_NODE=1 is set
  // (the app's Electron binary). Consumers run cliPath with it so the CLI
  // uses the exact runtime the app ships instead of whatever `node` is on
  // PATH.
  cliRuntimePath: requiredString.optional(),
});
export type ReviewDesktopDiscovery = z.infer<
  typeof ReviewDesktopDiscoverySchema
>;

export const ReviewRepositoryIdentitySchema = z.strictObject({
  kind: z.enum(["git", "jj", "none"], {
    error: "must be git, jj, or none",
  }),
  repositoryId: requiredString,
  repositoryPath: requiredString,
  worktreeRoot: requiredString,
});
export type ReviewRepositoryIdentity = z.infer<
  typeof ReviewRepositoryIdentitySchema
>;
export type ReviewRepositoryKind = ReviewRepositoryIdentity["kind"];

export const ReviewStatusSchema = z.enum([
  "draft",
  "awaiting-review",
  "awaiting-agent-updates",
  "accepted",
  "rejected",
]);

export const ReviewSourceIdentitySchema = z.strictObject({
  kind: z.enum(["git-branch", "git-commit", "jj-bookmark", "jj-change"]),
  name: requiredString,
});
export type ReviewSourceIdentity = z.infer<typeof ReviewSourceIdentitySchema>;

export const ReviewAgentSessionRoleSchema = z.enum([
  "author",
  "map-worker",
  "publisher",
  "updater",
  "question",
]);
export type ReviewAgentSessionRole = z.infer<
  typeof ReviewAgentSessionRoleSchema
>;

export const ReviewAgentSessionAttributionSchema = z.strictObject({
  roles: z.array(ReviewAgentSessionRoleSchema),
  firstSeenAt: requiredString,
  lastSeenAt: requiredString,
});
export type ReviewAgentSessionAttribution = z.infer<
  typeof ReviewAgentSessionAttributionSchema
>;

export const ReviewRecordSchema = z.strictObject({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  uuid: z.uuid({ error: "must be a UUID" }),
  /* System Reviews use the complete stored-Review/session pipeline without
     appearing in user-facing Review lists. Absence preserves the historical
     user-visible default. */
  visibility: z.literal("system").optional(),
  repoKey: requiredString,
  worktreePath: requiredString,
  baseRef: requiredString,
  baseCommit: requiredString,
  sourceCommit: requiredString.nullable(),
  sourceIdentity: ReviewSourceIdentitySchema.nullable(),
  pullRequestNumber: positiveInteger.nullable().optional(),
  pullRequestUrl: absoluteUrlSchema.nullable().optional(),
  title: stringAllowEmpty,
  sourceSession: requiredString,
  agentSessions: z
    .record(requiredString, ReviewAgentSessionAttributionSchema)
    .optional(),
  status: ReviewStatusSchema,
  presentedDocumentRevision: requiredString.nullable(),
  presentedSoftwareMapRevision: requiredString.nullable(),
  createdAt: requiredString,
  lastPublishedAt: requiredString.nullable(),
  /* The attention axis, separate from status: status tracks the agent handoff,
     these track the reader. Both stay optional so a review.json written before
     this field existed still parses and needs no migration. */
  viewedAt: requiredString.nullable().optional(),
  dismissedAt: requiredString.nullable().optional(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const ReviewCommitSummarySchema = z.strictObject({
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision"),
  parentCommit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision"),
  subject: stringAllowEmpty,
  author: stringAllowEmpty,
  authoredAt: requiredString,
  fileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ReviewCommitSummary = z.infer<typeof ReviewCommitSummarySchema>;

export const ReviewDescriptorSchema = z.strictObject({
  uuid: z.uuid({ error: "must be a UUID" }),
  title: stringAllowEmpty,
  status: z.enum([
    "draft",
    "awaiting-review",
    "awaiting-agent-updates",
    "accepted",
    "rejected",
  ]),
  worktreePath: requiredString,
  repoKey: requiredString,
  sourceBranch: requiredString.nullable(),
  baseRef: requiredString.optional(),
  headRef: requiredString.optional(),
  commits: z.array(ReviewCommitSummarySchema).optional(),
  pullRequestNumber: positiveInteger.nullable().optional(),
  pullRequestUrl: absoluteUrlSchema.nullable().optional(),
  diffStats: z
    .strictObject({
      fileCount: nonNegativeInteger,
      additions: nonNegativeInteger,
      deletions: nonNegativeInteger,
    })
    .nullable()
    .optional(),
  commentCount: nonNegativeInteger.optional(),
  documentUpdatedAt: requiredString.nullable().optional(),
  presentedDocumentRevision: requiredString.nullable(),
  presentedSoftwareMapRevision: requiredString.nullable(),
  lastPublishedAt: requiredString.nullable(),
  available: z.boolean(),
  viewedAt: requiredString.nullable().optional(),
  dismissedAt: requiredString.nullable().optional(),
  /* Absolute deadline, so Home can count down without knowing the retention
     setting. Null when retention is off or the review is not dismissed. */
  reapsAt: requiredString.nullable().optional(),
});
export type ReviewDescriptor = z.infer<typeof ReviewDescriptorSchema>;

export const ReviewSessionDescriptorSchema = z.strictObject({
  sessionId: requiredString,
  sessionUrl: loopbackUrlSchema,
  reviewUuid: z.uuid({ error: "must be a UUID" }),
  routePath: routePathSchema,
  startedAt: positiveInteger,
  historicalRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
export type ReviewSessionDescriptor = z.infer<
  typeof ReviewSessionDescriptorSchema
>;

export const ReviewDocumentVersionSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  /** Unix milliseconds when the version was sealed. */
  sealedAt: positiveInteger,
  isCurrent: z.boolean(),
});
export type ReviewDocumentVersionWire = z.infer<
  typeof ReviewDocumentVersionSchema
>;

/** The native agent session that authored the review. */
export const AuthoringAgentSessionSchema = z.strictObject({
  harness: z.enum(["claude-code", "codex", "pi"]),
  sessionId: requiredString,
});
export type AuthoringAgentSessionWire = z.infer<
  typeof AuthoringAgentSessionSchema
>;

export const ReviewErrorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: requiredString,
});
export type ReviewErrorResponse = z.infer<typeof ReviewErrorResponseSchema>;

export const ReviewDocumentFileResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), file: ReviewDocumentFileSchema }),
  ReviewErrorResponseSchema,
]);
export type ReviewDocumentFileResponse = z.infer<
  typeof ReviewDocumentFileResponseSchema
>;

export const ReviewDocumentSnapshotResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    snapshot: ReviewDocumentSnapshotSchema,
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewDocumentSnapshotResponse = z.infer<
  typeof ReviewDocumentSnapshotResponseSchema
>;

export const ReviewDocumentMutationResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    mutationId: threadTargetNonEmptyStringSchema,
    snapshot: ReviewDocumentSnapshotSchema,
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewDocumentMutationResponse = z.infer<
  typeof ReviewDocumentMutationResponseSchema
>;

export const ReviewThreadsSnapshotResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    snapshot: ReviewThreadsSnapshotSchema,
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewThreadsSnapshotResponse = z.infer<
  typeof ReviewThreadsSnapshotResponseSchema
>;

export const ReviewThreadsCommandResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    commit: ReviewThreadsCommitSchema,
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewThreadsCommandResponse = z.infer<
  typeof ReviewThreadsCommandResponseSchema
>;

export const ReviewOpenResponseSchema = z.strictObject({
  sessionId: requiredString,
  url: loopbackUrlSchema,
  session: ReviewSessionDescriptorSchema,
  review: ReviewDescriptorSchema,
});
export type ReviewOpenResponse = z.infer<typeof ReviewOpenResponseSchema>;

/* The tutorial Review is not in the review store, so `GET /reviews` never
   lists it. The open response carries its descriptor and live session so the
   app can open the tab without the Home list. */
export const ReviewTutorialOpenResponseSchema = z.strictObject({
  reviewUuid: z.uuid({ error: "must be a UUID" }),
  sessionId: requiredString,
  url: loopbackUrlSchema,
  review: ReviewDescriptorSchema,
  session: ReviewSessionDescriptorSchema,
});
export type ReviewTutorialOpenResponse = z.infer<
  typeof ReviewTutorialOpenResponseSchema
>;

export const ReviewListResponseSchema = z.strictObject({
  reviews: z.array(ReviewDescriptorSchema),
  errors: z.array(
    z.strictObject({
      reviewDir: requiredString,
      reviewUuid: z.uuid({ error: "must be a UUID" }).nullable(),
      title: stringAllowEmpty,
      worktreePath: requiredString,
      lastPublishedAt: requiredString.nullable(),
      message: requiredString,
      code: requiredString.optional(),
    }),
  ),
});
export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;
export type ReviewListError = ReviewListResponse["errors"][number];

export const ReviewCliInstallTargetSchema = z.enum(
  ["claude", "codex", "cursor", "pi"],
  { error: "must be claude, codex, cursor, or pi" },
);
export type ReviewCliInstallTarget = z.infer<
  typeof ReviewCliInstallTargetSchema
>;

export const ReviewFffInstallTargetSchema = z.enum(["claude", "codex", "pi"], {
  error: "must be claude, codex, or pi",
});
export type ReviewFffInstallTarget = z.infer<
  typeof ReviewFffInstallTargetSchema
>;

export const ReviewFffManagedRegistrationSchema = z.strictObject({
  target: ReviewFffInstallTargetSchema,
  command: requiredString,
  args: z.array(requiredString),
});
export type ReviewFffManagedRegistration = z.infer<
  typeof ReviewFffManagedRegistrationSchema
>;

export const ReviewCliInstallStampSchema = z.strictObject({
  consent: z.enum(["granted", "declined", "skipped"], {
    error: "must be granted, declined, or skipped",
  }),
  fingerprint: requiredString.optional(),
  targets: z.array(ReviewCliInstallTargetSchema).optional(),
  shimPath: requiredString.optional(),
  fffRegistrations: z.array(ReviewFffManagedRegistrationSchema).optional(),
  traceManaged: z.boolean().optional(),
  updatedAt: requiredString,
});
export type ReviewCliInstallStamp = z.infer<typeof ReviewCliInstallStampSchema>;

export const ReviewCliInstallStatusSchema = z.strictObject({
  agents: z.array(
    z.strictObject({
      target: ReviewCliInstallTargetSchema,
      present: z.boolean(),
      installed: z.boolean(),
    }),
  ),
  fingerprint: requiredString,
  stamp: ReviewCliInstallStampSchema.nullable(),
  stale: z.boolean(),
  shim: z.strictObject({
    path: requiredString,
    installed: z.boolean(),
    profileConfigured: z.boolean(),
    onPath: z.boolean(),
  }),
  fff: z.strictObject({
    serverName: z.literal("fff"),
    corpusRoot: requiredString,
    binary: z.strictObject({ path: requiredString, installed: z.boolean() }),
    registrations: z.array(
      z.strictObject({
        target: ReviewFffInstallTargetSchema,
        present: z.boolean(),
        managed: z.boolean(),
      }),
    ),
  }),
  trace: z.strictObject({
    enabled: z.boolean(),
    configured: z.boolean(),
    autoActivateRepositories: z.boolean(),
    envPath: requiredString,
    settingsPath: requiredString,
    endpoint: requiredString.optional(),
    bucket: requiredString.optional(),
    region: requiredString.optional(),
    accessKeyIdPrefix: requiredString.optional(),
    verifiedAt: requiredString.optional(),
    error: requiredString.optional(),
  }),
  // Null when the serving package has no built CLI (a source-run dev server).
  cli: z
    .strictObject({ path: requiredString, version: requiredString })
    .nullable(),
});
export type ReviewCliInstallStatus = z.infer<
  typeof ReviewCliInstallStatusSchema
>;

// Skills and FFF integrations are per-agent. Skill requests install the review
// command by default. The command, FFF binary, and trace configuration are
// per-machine. Silent app updates omit `fff` and `trace`, so they do not run an
// FFF installer or contact R2.
export const ReviewCliInstallApplyRequestSchema = z
  .strictObject({
    targets: z.array(ReviewCliInstallTargetSchema),
    shim: z.boolean().optional(),
    fff: z.boolean().optional(),
    trace: z
      .union([
        z.literal(true),
        z.strictObject({
          endpoint: requiredString.optional(),
          bucket: requiredString.optional(),
          key: requiredString.optional(),
          secret: requiredString.optional(),
          region: requiredString.optional(),
        }),
      ])
      .optional(),
  })
  .refine(
    (request) =>
      request.targets.length > 0 ||
      request.shim === true ||
      request.fff === true ||
      request.trace !== undefined,
    { message: "must install skills, the command, FFF, or trace capture" },
  );
export type ReviewCliInstallApplyRequest = z.infer<
  typeof ReviewCliInstallApplyRequestSchema
>;

export const ReviewCliInstallApplyResponseSchema = z.strictObject({
  ok: z.boolean(),
  output: stringAllowEmpty,
  shimPath: requiredString.optional(),
});
export type ReviewCliInstallApplyResponse = z.infer<
  typeof ReviewCliInstallApplyResponseSchema
>;

// The CLI validates, bundles, and seals the revision; this request tells the
// desktop which sealed revision to materialize, promote, and mount.
export const ReviewPublishReadyRequestSchema = z.strictObject({
  reviewUuid: z.uuid({ error: "must be a UUID" }),
  revision: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision"),
  agent: AuthoringAgentSessionSchema.optional(),
  view: reviewViewSchema.optional(),
});
export type ReviewPublishReadyRequest = z.infer<
  typeof ReviewPublishReadyRequestSchema
>;

export const ReviewSubmissionWireSchema = z.strictObject({
  id: requiredString,
  decision: z.enum(["approve", "request-changes"]),
  createdAt: requiredString,
  rootPath: requiredString,
  reviewPath: requiredString,
  documentRoute: requiredString,
  appUrl: requiredString.optional(),
  baseRef: requiredString.optional(),
  headRef: requiredString.optional(),
  pullRequestNumber: positiveInteger.optional(),
  agent: AuthoringAgentSessionSchema.optional(),
  codexThreadId: requiredString.optional(),
  comments: z.array(z.unknown()),
  prompt: stringAllowEmpty,
});
export type ReviewSubmissionWire = z.infer<typeof ReviewSubmissionWireSchema>;

export const ReviewSessionLifecycleEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("ready"), sessionId: requiredString }),
  z.strictObject({
    event: z.literal("submitted"),
    sessionId: requiredString,
    submission: ReviewSubmissionWireSchema,
  }),
  z.strictObject({
    event: z.literal("dismissed"),
    sessionId: requiredString,
    reason: z.enum(["closed", "replaced", "app-exit"]),
  }),
  z.strictObject({
    event: z.literal("error"),
    sessionId: requiredString,
    error: requiredString,
  }),
]);
export type ReviewSessionLifecycleEvent = z.infer<
  typeof ReviewSessionLifecycleEventSchema
>;

export const ReviewDesktopGlobalEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("session-registered"),
    session: ReviewSessionDescriptorSchema,
    /* Publish carries the newly authoritative Home row. Ordinary session
       opens omit it because Home already has the published descriptor. */
    review: ReviewDescriptorSchema.optional(),
    // True when the session was opened for a non-document surface (the
    // Source tab rooting its file tree): the app must not surface the
    // review document tab for it. Absent means foreground.
    background: z.boolean().optional(),
  }),
  z.strictObject({
    event: z.literal("session-updated"),
    session: ReviewSessionDescriptorSchema,
  }),
  z.strictObject({
    event: z.literal("review-data-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    sessionId: requiredString,
  }),
  z.strictObject({
    event: z.literal("review-threads-committed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    sessionId: requiredString.optional(),
    commit: ReviewThreadsCommitSchema,
    commentCount: nonNegativeInteger,
  }),
  z.strictObject({
    event: z.literal("review-document-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    routePath: routePathSchema,
    revision: nonNegativeInteger,
    mutationId: threadTargetNonEmptyStringSchema,
  }),
  z.strictObject({
    event: z.literal("session-closed"),
    sessionId: requiredString,
    reason: requiredString,
  }),
  z.strictObject({
    event: z.literal("review-status-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    status: ReviewStatusSchema,
    decision: z.enum(["approve", "request-changes"]).optional(),
  }),
  z.strictObject({
    event: z.literal("review-deleted"),
    uuid: z.uuid({ error: "must be a UUID" }),
  }),
  /* Dismissal is the reader's terminal action. `review wait` treats it as an
     end state, the same way it treats a deletion. */
  z.strictObject({
    event: z.literal("review-attention-changed"),
    uuid: z.uuid({ error: "must be a UUID" }),
    attention: z.enum(["new", "viewed", "dismissed"]),
    viewedAt: requiredString.nullable(),
    dismissedAt: requiredString.nullable(),
    reapsAt: requiredString.nullable(),
  }),
  z.strictObject({
    event: z.literal("preferences-changed"),
    preferences: z.strictObject({
      dismissedRetentionDays: positiveInteger.nullable(),
    }),
  }),
]);
export type ReviewDesktopGlobalEvent = z.infer<
  typeof ReviewDesktopGlobalEventSchema
>;

export const ReviewSessionSchema = z.strictObject({
  sessionId: requiredString.optional(),
  rootPath: requiredString,
  baseRootPath: requiredString.optional(),
  headRootPath: requiredString.optional(),
  baseRef: requiredString,
  headRef: requiredString.optional(),
  pullRequestNumber: positiveInteger.optional(),
  pullRequestUrl: absoluteUrlSchema.optional(),
  routePath: routePathSchema.optional(),
  appUrl: absoluteUrlSchema,
  appPort: positiveInteger.optional(),
  serverUrl: urlSchema("origin").optional(),
  sessionUrl: loopbackUrlSchema.optional(),
  storageDir: requiredString.optional(),
  reviewPath: requiredString,
  codeGraphUrl: absoluteUrlSchema.optional(),
  agent: AuthoringAgentSessionSchema.optional(),
  freshQuestionHarness: AuthoringAgentSessionSchema.shape.harness.optional(),
  codexThreadId: requiredString.optional(),
  resolvedBaseRef: requiredString.nullable().optional(),
  reviewStatus: ReviewStatusSchema.optional(),
  historicalRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  startedAt: positiveInteger,
});
export type ReviewSessionWire = z.infer<typeof ReviewSessionSchema>;

export const ReviewDiffFileSchema = z.strictObject({
  path: requiredString,
  previousPath: requiredString.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: nonNegativeInteger,
  deletions: nonNegativeInteger,
  patch: requiredString.optional(),
});
export type ReviewDiffFileWire = z.infer<typeof ReviewDiffFileSchema>;

export interface ReviewDiffStats {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export function summarizeReviewDiffFiles(
  files: readonly {
    readonly additions?: number;
    readonly deletions?: number;
  }[],
): ReviewDiffStats {
  return files.reduce<ReviewDiffStats>(
    (total, file) => ({
      fileCount: total.fileCount + 1,
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { fileCount: 0, additions: 0, deletions: 0 },
  );
}

export const ReviewDiffFilesRequestSchema = z.strictObject({
  includePatch: z.boolean().optional(),
  paths: z.array(z.string()).optional(),
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision")
    .optional(),
});
export type ReviewDiffFilesRequest = z.infer<
  typeof ReviewDiffFilesRequestSchema
>;

export const ReviewDiffFilesResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    baseRef: requiredString.optional(),
    headRef: requiredString.optional(),
    files: z.array(ReviewDiffFileSchema),
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewDiffFilesResponse = z.infer<
  typeof ReviewDiffFilesResponseSchema
>;

export const ReviewFileContentRequestSchema = z.strictObject({
  path: requiredString,
  side: reviewDiffSideSchema,
  commit: z
    .string({ error: "must be a 40-hex revision" })
    .regex(/^[0-9a-f]{40}$/i, "must be a 40-hex revision")
    .optional(),
});
export type ReviewFileContentRequest = z.infer<
  typeof ReviewFileContentRequestSchema
>;

export const ReviewFileContentResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    content: stringAllowEmpty,
    truncated: z.boolean().optional(),
  }),
  z.strictObject({ ok: z.literal(true), absent: z.literal(true) }),
  z.strictObject({ ok: z.literal(true), binary: z.literal(true) }),
  ReviewErrorResponseSchema,
]);
export type ReviewFileContentResponse = z.infer<
  typeof ReviewFileContentResponseSchema
>;

export const ReviewSessionResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    session: ReviewSessionSchema,
    token: requiredString,
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewSessionResponse = z.infer<typeof ReviewSessionResponseSchema>;

export const ReviewDocModuleResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    contentHash: requiredString,
    moduleUrl: absoluteUrlSchema,
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewDocModuleResponse = z.infer<
  typeof ReviewDocModuleResponseSchema
>;

export const ReviewSoftwareMapModuleResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z.strictObject({
      ok: z.literal(true),
      contentHash: requiredString,
      headModuleUrl: absoluteUrlSchema,
      baseModuleUrl: absoluteUrlSchema,
    }),
    ReviewErrorResponseSchema,
  ],
);
export type ReviewSoftwareMapModuleResponse = z.infer<
  typeof ReviewSoftwareMapModuleResponseSchema
>;

export const ReviewServerEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("session-updated"),
    session: ReviewSessionSchema,
  }),
  z.strictObject({
    event: z.literal("submitted"),
    submissionId: requiredString,
    decision: z.enum(["approve", "request-changes"]),
  }),
  z.strictObject({
    event: z.literal("review-threads-committed"),
    commit: ReviewThreadsCommitSchema,
  }),
]);
export type ReviewServerEvent = z.infer<typeof ReviewServerEventSchema>;

export const ReviewRangeSchema = z
  .strictObject({
    fromLine: positiveInteger,
    toLine: positiveInteger,
  })
  .superRefine((range, context) => {
    if (range.toLine < range.fromLine) {
      context.addIssue({
        code: "custom",
        message: "must be >= fromLine",
        path: ["toLine"],
      });
    }
  });
export type ReviewRangeWire = z.infer<typeof ReviewRangeSchema>;

export const ReviewOpenEditorSchema = z.strictObject({
  path: requiredString,
  scheme: requiredString,
});
export type ReviewOpenEditorWire = z.infer<typeof ReviewOpenEditorSchema>;

export const ReviewEditorSelectionSchema = z.strictObject({
  path: requiredString,
  startLine: positiveInteger,
  startColumn: positiveInteger,
  endLine: positiveInteger,
  endColumn: positiveInteger,
});
export type ReviewEditorSelectionWire = z.infer<
  typeof ReviewEditorSelectionSchema
>;

export const ReviewDesktopStateSchema = z.strictObject({
  openEditors: z.array(ReviewOpenEditorSchema),
  activeEditor: ReviewOpenEditorSchema.nullable(),
  selection: ReviewEditorSelectionSchema.nullable(),
});
export type ReviewDesktopState = z.infer<typeof ReviewDesktopStateSchema>;

const reviewThreadDecorationKindSchema = z.enum([
  "comment",
  "draft",
  "resolved",
]);
export type ReviewThreadDecorationKind = z.infer<
  typeof reviewThreadDecorationKindSchema
>;

export const ReviewThreadAnchorSchema = z
  .strictObject({
    startLine: positiveInteger,
    endLine: positiveInteger,
    threadId: requiredString,
    kind: reviewThreadDecorationKindSchema,
  })
  .superRefine((anchor, context) => {
    if (anchor.endLine < anchor.startLine) {
      context.addIssue({
        code: "custom",
        message: "must be >= startLine",
        path: ["endLine"],
      });
    }
  });
export type ReviewThreadAnchorWire = z.infer<typeof ReviewThreadAnchorSchema>;

const openFileArgsSchema = z
  .strictObject({
    path: requiredString,
    line: positiveInteger.optional(),
    column: positiveInteger.optional(),
    endLine: positiveInteger.optional(),
    preserveFocus: z.boolean().optional(),
  })
  .superRefine((args, context) => {
    if (args.line === undefined && args.endLine !== undefined) {
      context.addIssue({
        code: "custom",
        message: "requires args.line",
        path: ["endLine"],
      });
    } else if (
      args.line !== undefined &&
      args.endLine !== undefined &&
      args.endLine < args.line
    ) {
      context.addIssue({
        code: "custom",
        message: "must be >= args.line",
        path: ["endLine"],
      });
    }
  });
const revealArgsSchema = z
  .strictObject({
    path: requiredString,
    startLine: positiveInteger,
    endLine: positiveInteger,
    side: reviewDiffSideSchema.optional(),
    highlight: z.boolean().optional(),
    preserveFocus: z.boolean().optional(),
  })
  .superRefine((args, context) => {
    if (args.endLine < args.startLine) {
      context.addIssue({
        code: "custom",
        message: "must be >= args.startLine",
        path: ["endLine"],
      });
    }
  });

export const ReviewVerbRequestSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("openFile"), args: openFileArgsSchema }),
  z.strictObject({
    name: z.literal("showReviewView"),
    args: z.strictObject({ view: reviewViewSchema }),
  }),
  z.strictObject({
    name: z.literal("openSourceTree"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    name: z.literal("openDiff"),
    args: z.strictObject({
      path: requiredString,
      previousPath: requiredString.optional(),
    }),
  }),
  z.strictObject({ name: z.literal("reveal"), args: revealArgsSchema }),
  z.strictObject({
    name: z.literal("decorateThreads"),
    args: z.strictObject({
      sessionId: requiredString.optional(),
      path: requiredString,
      anchors: z.array(ReviewThreadAnchorSchema),
    }),
  }),
  z.strictObject({
    name: z.literal("clearDecorations"),
    args: z.strictObject({
      sessionId: requiredString.optional(),
      path: requiredString.optional(),
    }),
  }),
  z.strictObject({ name: z.literal("focusCanvas"), args: z.strictObject({}) }),
  z.strictObject({ name: z.literal("focusWindow"), args: z.strictObject({}) }),
  z.strictObject({
    name: z.literal("captureScreenshot"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    name: z.literal("openReviewRevision"),
    args: z.strictObject({
      revision: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
      sealedAt: positiveInteger.optional(),
    }),
  }),
  z.strictObject({ name: z.literal("showThreads"), args: z.strictObject({}) }),
  z.strictObject({
    name: z.literal("openNativeAgentTerminal"),
    args: z.strictObject({
      launchId: requiredString,
      harness: AuthoringAgentSessionSchema.shape.harness,
      cwd: requiredString,
      executable: requiredString,
      args: z.array(z.string()),
      env: z.record(requiredString, z.string()),
    }),
  }),
  // Server-to-app only: mount the (unpromoted) session's document off-screen
  // and report the result, so publish can gate promotion on a clean mount.
  z.strictObject({
    name: z.literal("validateCanvasMount"),
    args: z.strictObject({}),
  }),
  z.strictObject({ name: z.literal("state"), args: z.strictObject({}) }),
]);
export type ReviewVerbRequest = z.infer<typeof ReviewVerbRequestSchema>;

export const ReviewVerbResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.unknown().optional() }),
  ReviewErrorResponseSchema,
]);
export type ReviewVerbResponse = z.infer<typeof ReviewVerbResponseSchema>;

export const ReviewDesktopVerbFrameSchema = z.strictObject({
  event: z.literal("desktop-verb"),
  id: requiredString,
  sessionId: requiredString,
  request: ReviewVerbRequestSchema,
});
export type ReviewDesktopVerbFrame = z.infer<
  typeof ReviewDesktopVerbFrameSchema
>;

export const ReviewDesktopVerbResultSchema = z.strictObject({
  id: requiredString,
  sessionId: requiredString,
  response: ReviewVerbResponseSchema,
});
export type ReviewDesktopVerbResult = z.infer<
  typeof ReviewDesktopVerbResultSchema
>;

export const ReviewSurfaceEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("activeEditorChanged"),
    path: requiredString.nullable(),
  }),
  z.strictObject({
    event: z.literal("editorSelectionChanged"),
    path: requiredString,
    range: ReviewRangeSchema,
  }),
  z.strictObject({
    event: z.literal("commentRequested"),
    path: requiredString,
    range: ReviewRangeSchema,
    sideContext: reviewDiffSideSchema,
  }),
  z.strictObject({
    event: z.literal("threadDecorationClicked"),
    threadId: requiredString,
  }),
  z.strictObject({
    event: z.literal("agentTerminalOpening"),
    sessionId: requiredString,
  }),
  z.strictObject({
    event: z.literal("themeChanged"),
    theme: reviewThemeSchema,
  }),
  z.strictObject({
    event: z.literal("showReviewView"),
    view: reviewViewSchema,
  }),
]);
export type ReviewSurfaceEvent = z.infer<typeof ReviewSurfaceEventSchema>;

// --- Agent trace view & trace quotes ----------------------------------------

export const ReviewAgentTraceEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    text: stringAllowEmpty,
    at: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("assistant"),
    markdown: stringAllowEmpty,
    thinking: z.boolean().optional(),
    at: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: requiredString,
    verb: requiredString,
    title: stringAllowEmpty,
    filePath: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    command: z.string().optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    error: z.boolean().optional(),
    at: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("separator"),
    label: requiredString,
  }),
]);
export type ReviewAgentTraceEvent = z.infer<typeof ReviewAgentTraceEventSchema>;

export const ReviewAgentTraceSessionSchema = z.strictObject({
  sessionId: requiredString,
  harness: z.enum(["claude-code", "codex", "pi", "unknown"]),
  available: z.boolean(),
  source: z.enum(["r2"]).nullable(),
  notSynced: z.boolean().optional(),
  subagents: z.array(requiredString).optional(),
  commits: z.array(
    z.strictObject({ sha: requiredString, subject: stringAllowEmpty }),
  ),
});
export type ReviewAgentTraceSession = z.infer<
  typeof ReviewAgentTraceSessionSchema
>;

export const ReviewAgentTraceListResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    configured: z.boolean().default(true),
    sessions: z.array(ReviewAgentTraceSessionSchema),
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewAgentTraceListResponse = z.infer<
  typeof ReviewAgentTraceListResponseSchema
>;

export const ReviewAgentTraceResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    parserVersion: requiredString,
    session: ReviewAgentTraceSessionSchema,
    trace: stringAllowEmpty.nullable().optional(),
    subagents: z.array(requiredString).default([]),
    title: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    activeMs: z.number().nullable(),
    userTurns: z.number(),
    toolCalls: z.number(),
    events: z.array(ReviewAgentTraceEventSchema),
  }),
  ReviewErrorResponseSchema,
]);
export type ReviewAgentTraceResponse = z.infer<
  typeof ReviewAgentTraceResponseSchema
>;
