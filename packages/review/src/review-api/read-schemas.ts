import { z } from "zod";

// Query schemas for the read routes. http.ts parses query strings with them
// and authoring-tools.ts publishes the same shapes, so the two cannot drift.
// Coercion and defaults only affect parsing; the published input schema keeps
// the JSON types.
const version = z
  .union([
    z.literal("").transform(() => undefined),
    z.coerce.number().int().nonnegative(),
  ])
  .optional();

const commit = z.string().min(1).optional();

const side = z.enum(["base", "head"]);

export const inspectQuerySchema = z.strictObject({
  version,
  targetId: z.string().min(1).optional(),
  full: z.union([z.literal(true), z.literal("true")]).optional(),
  format: z.enum(["text", "json"]).default("text"),
});

export const readQuerySchemas = {
  get: z.strictObject({
    version,
    targetId: z.string().min(1).optional(),
    full: z.union([z.literal(true), z.literal("true")]).optional(),
  }),
  maps: z.strictObject({ version }),
  tree: z.strictObject({
    version,
    commit,
    side: side.default("head"),
    path: z.string().default(""),
  }),
  file: z.strictObject({ version, commit, side, file: z.string().min(1) }),
  diff: z.strictObject({ version, commit, file: z.string().min(1).optional() }),
  commits: z.strictObject({ version }),
};
