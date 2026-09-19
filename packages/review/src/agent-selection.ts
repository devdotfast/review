import {
  ReviewApiSelectionSourceSchema,
  ReviewSelectedDiffSchema,
} from "@dev.fast/review-protocol";
import { z } from "zod";

/** A semantic selection, independent of comment/thread creation. */
export const AgentSelectionSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), quote: z.string() }),
    z.strictObject({
      kind: z.literal("code"),
      path: z.string(),
      side: z.enum(["base", "head"]),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    }),
  ]),
  title: z.string().max(500),
  detail: z.string().max(24000).optional(),
  revision: z.string().max(200).optional(),
  selectedDiff: ReviewSelectedDiffSchema.optional(),
  apiSource: ReviewApiSelectionSourceSchema.optional(),
});

export type AgentSelection = z.infer<typeof AgentSelectionSchema>;

export function selectionMarkdown(
  selection: AgentSelection,
  sourceExcerpt = "",
  diffPaths?: { base: string; head: string },
): string {
  const target = selection.target;

  if (selection.selectedDiff)
    return selectedDiffMarkdown(selection.selectedDiff, diffPaths);

  if (target.kind === "text")
    return target.quote
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");

  return [`## ${selection.title}`, selection.detail ?? "", sourceExcerpt]
    .filter(Boolean)
    .join("\n\n");
}

export function selectedDiffMarkdown(
  diff: z.infer<typeof ReviewSelectedDiffSchema>,
  paths?: { base: string; head: string },
): string {
  const oldCount = diff.rows.filter((row) => row.kind !== "added").length;
  const newCount = diff.rows.filter((row) => row.kind !== "deleted").length;

  const lines = diff.rows.map(
    (row) =>
      `${row.kind === "added" ? "+" : row.kind === "deleted" ? "-" : " "}${row.text}`,
  );

  // Keep Markdown source containing backtick fences inside this diff fence.
  const fence = "`".repeat(
    Math.max(
      3,
      ...lines.flatMap((line) =>
        [...line.matchAll(/`+/g)].map((match) => match[0].length + 1),
      ),
    ),
  );

  return [
    `Base: ${paths?.base ?? "a/"}`,
    `Head: ${paths?.head ?? "b/"}`,
    `Range: -${diff.oldStart},${oldCount} +${diff.newStart},${newCount}`,
    "",
    `${fence}diff`,
    ...lines,
    fence,
  ].join("\n");
}
