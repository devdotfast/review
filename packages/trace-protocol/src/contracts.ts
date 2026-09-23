import { z } from "zod";

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

// These names avoid collisions when the native overlay inlines both packages.
const nonBlankString = z
  .string({ error: "must be a string" })
  .refine((value) => value.trim().length > 0, "must be a string");

const anyString = z.string({ error: "must be a string" });

export const ReviewAgentTraceEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    text: anyString,
    at: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("assistant"),
    markdown: anyString,
    thinking: z.boolean().optional(),
    at: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: nonBlankString,
    verb: nonBlankString,
    title: anyString,
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
    label: nonBlankString,
  }),
]);

export type ReviewAgentTraceEvent = z.infer<typeof ReviewAgentTraceEventSchema>;

export const ReviewAgentTraceSessionSchema = z.strictObject({
  sessionId: nonBlankString,
  title: z.string().optional(),
  harness: z.enum(["claude-code", "codex", "opencode", "pi", "unknown"]),
  available: z.boolean(),
  source: z.enum(["r2"]).nullable(),
  notSynced: z.boolean().optional(),
  subagents: z.array(nonBlankString).optional(),
  commits: z.array(z.strictObject({ sha: nonBlankString, subject: anyString })),
});

export type ReviewAgentTraceSession = z.infer<
  typeof ReviewAgentTraceSessionSchema
>;
