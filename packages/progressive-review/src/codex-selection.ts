import {
  ReviewSelectedDiffSchema,
  ThreadTargetSchema,
} from "@dev.fast/review-protocol";
import { z } from "zod";

/** A semantic selection, independent of comment/thread creation. */
export const CodexSelectionSchema = z.strictObject({
  clientId: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative(),
  selection: z
    .strictObject({
      target: ThreadTargetSchema,
      title: z.string().max(500),
      detail: z.string().max(24000).optional(),
      revision: z.string().max(200).optional(),
      selectedDiff: ReviewSelectedDiffSchema.optional(),
      fileOnly: z.boolean().optional(),
    })
    .nullable(),
});

export type CodexSelection = NonNullable<
  z.infer<typeof CodexSelectionSchema>["selection"]
>;

export function selectionMarkdown(
  selection: CodexSelection,
  sourceExcerpt = "",
  diffPaths?: { base: string; head: string },
): string {
  const target = selection.target;

  if (selection.fileOnly) return "";

  if (selection.selectedDiff)
    return selectedDiffMarkdown(selection.selectedDiff, diffPaths);

  if (target.kind === "text") return target.selection.quote;

  return [
    `## ${selection.title}`,
    target.kind === "graph" ? target.element.quote : "",
    selection.detail ?? "",
    sourceExcerpt,
  ]
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
    `${fence}diff`,
    `--- ${diff.oldPath ? (paths?.base ?? `a/${diff.oldPath}`) : "/dev/null"}`,
    `+++ ${diff.newPath ? (paths?.head ?? `b/${diff.newPath}`) : "/dev/null"}`,
    `@@ -${diff.oldStart},${oldCount} +${diff.newStart},${newCount} @@`,
    ...lines,
    fence,
  ].join("\n");
}
