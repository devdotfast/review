import { ReviewSelectedDiffSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

/** A semantic selection, independent of comment/thread creation. */
export const AgentSelectionSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), quote: z.string() }),
    z.strictObject({
      kind: z.literal("graph"),
      diagram: z.string(),
      label: z.string(),
      elementType: z.enum(["node", "edge"]),
    }),
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
  diagramContext: z
    .object({
      kind: z.enum([
        "node",
        "sequence message",
        "relationship",
        "database use case",
      ]),
      description: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      incoming: z.array(z.string()).optional(),
      outgoing: z.array(z.string()).optional(),
      operations: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
      code: z.string().optional(),
    })
    .optional(),
  revision: z.string().max(200).optional(),
  selectedDiff: ReviewSelectedDiffSchema.optional(),
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

  if (target.kind === "graph") {
    const context = selection.diagramContext;

    const label =
      context?.kind === "sequence message"
        ? "Message"
        : context?.kind === "database use case"
          ? "Use case"
          : target.elementType === "edge"
            ? "Relationship"
            : "Node";

    const list = (heading: string, values?: string[]) =>
      values?.length
        ? `${heading}:\n${values.map((value) => `- ${value}`).join("\n")}`
        : "";

    return [
      `Diagram: ${target.diagram}`,
      context?.from && context?.to ? `${context.from} → ${context.to}` : "",
      `${label}: ${target.label}`,
      context?.description ? `Description:\n${context.description}` : "",
      list("Incoming", context?.incoming),
      list("Outgoing", context?.outgoing),
      list("Operations", context?.operations),
      list("Referenced code", context?.references),
      context?.code
        ? `Message code:\n${context.code
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

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
    `--- ${diff.oldPath ? (paths?.base ?? `a/${diff.oldPath}`) : "/dev/null"}`,
    `+++ ${diff.newPath ? (paths?.head ?? `b/${diff.newPath}`) : "/dev/null"}`,
    `@@ -${diff.oldStart},${oldCount} +${diff.newStart},${newCount} @@`,
    "",
    `${fence}diff`,
    ...lines,
    fence,
  ].join("\n");
}
