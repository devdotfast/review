import { z } from "zod";

import type { SourcePins } from "../source.js";
import { ReviewInputError } from "./input-error.js";

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

/** Read at a reference's own pins instead of the review's target. Flat, so
 * the same shape serves query strings and tool inputs. */
const anchor = {
  repositoryId: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
};

export function queryAnchor(input: {
  repositoryId?: string;
  head?: string;
  base?: string;
}) {
  if (!input.repositoryId && !input.head && !input.base) return undefined;

  if (!input.repositoryId || !input.head)
    throw new ReviewInputError(
      "Reading at explicit pins needs both repositoryId and head.",
    );

  const pins: SourcePins = {
    repositoryId: input.repositoryId,
    head: input.head,
  };

  if (input.base) pins.base = input.base;

  return pins;
}

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
    ...anchor,
    side: side.default("head"),
    path: z.string().default(""),
  }),
  file: z.strictObject({
    version,
    commit,
    ...anchor,
    side,
    file: z.string().min(1),
  }),
  diff: z.strictObject({
    version,
    commit,
    ...anchor,
    /** Pathspec, like `git diff -- a b`: files or directories. Omit for every changed file. */
    paths: z.array(z.string().min(1)).max(200).optional(),
    /** "files" lists changes (like --numstat); "patch" returns numbered patches (like -p). */
    format: z.enum(["files", "patch"]).default("files"),
    /** Context lines around each change, like -U<n>. */
    context: z.coerce.number().int().min(0).max(50).optional(),
    /** Patch budget; files past it are listed with a paths:[…] hint. */
    maxBytes: z.coerce.number().int().positive().max(500_000).default(40_000),
    /** Legacy: same as paths:[file], format:"patch". */
    file: z.string().min(1).optional(),
  }),
  structuralDiff: z.strictObject({
    version,
    commit,
    ...anchor,
    file: z.string().min(1).optional(),
  }),
  commits: z.strictObject({ version }),
};
