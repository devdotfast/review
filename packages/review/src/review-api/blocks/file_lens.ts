import { searchResultDataSchema } from "diffr/schema";
import { z } from "zod";

import { sourceSchema } from "../../source.js";
import { ReviewInputError } from "../input-error.js";
import { type BlockDefinition, defineBlock, label } from "./definition.js";

const patternsSchema = z.array(label).min(1).max(1000);

export const fileLensTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("results"), results: z.array(searchResultDataSchema).min(1) }),
  z.strictObject({ kind: z.literal("files"), patterns: patternsSchema }),
  z.strictObject({
    kind: z.literal("ranges"),
    sources: z.array(sourceSchema).min(1).max(10000),
  }),
]);

export type FileLensTarget = z.infer<typeof fileLensTargetSchema>;

export const fileLensSchema = defineBlock("file_lens", {
  title: label,
  targets: z
    .array(fileLensTargetSchema)
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Union of whole changed-file paths/globs and pinned source ranges. Counts and viewed actions apply only to selected changed lines.",
    ),
  patterns: patternsSchema
    .optional()
    .describe(
      "Legacy whole-file selectors. Use targets for new lenses; do not combine patterns and targets.",
    ),
});

export type FileLensBlock = z.infer<typeof fileLensSchema>;

/** Normalize saved legacy lenses without rewriting historical documents. */
export function fileLensTargets(block: FileLensBlock): FileLensTarget[] {
  return block.targets ?? [{ kind: "files", patterns: block.patterns ?? [] }];
}

export const file_lens = {
  type: "file_lens",
  schema: fileLensSchema,
  check(block: FileLensBlock) {
    if ((block.patterns === undefined) === (block.targets === undefined))
      throw new ReviewInputError(
        "A file lens requires either targets or legacy patterns, not both.",
      );
    for (const pattern of fileLensTargets(block).flatMap((target) =>
      target.kind === "files" ? target.patterns : [],
    )) {
      if (
        pattern.startsWith("/") ||
        pattern.split("/").includes("..") ||
        pattern.includes("\\") ||
        pattern.includes("\0")
      )
        throw new ReviewInputError(
          "File lens patterns must be repository-relative paths or globs using forward slashes.",
        );
    }
  },
} satisfies BlockDefinition<FileLensBlock>;
