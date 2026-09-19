import type { ReviewDiffLensTarget } from "@dev.fast/review-protocol";
import { searchResultDataSchema } from "diffr/schema";
import type { SearchResultData, RegionData } from "diffr/types";
import { z } from "zod";

const label = z.string().trim().min(1);

/** A pinned source range as the canonical review document expresses it. The
 * side resolves against the enclosing review version's pins; a range alone is
 * never a global identity or cache key. */
export const sourceSchema = z
  .strictObject({
    side: z.enum(["base", "head"]).default("head"),
    file: label,
    fromLine: z.number().int().positive(),
    toLine: z.number().int().positive(),
  })
  .refine((s) => s.toLine >= s.fromLine, "Source range ends before it starts.");

export type Source = z.infer<typeof sourceSchema>;

/** Read legacy saved evidence without changing its retained trees or fold state.
 * Old one-sided payloads stay one-sided; missing historical data is not invented. */
export function upgradeStoredEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(upgradeStoredEvidence);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (
    typeof object.kind === "string" &&
    ["lhs", "rhs", "combined", "unchanged"].includes(object.kind) &&
    object.scope &&
    object.file &&
    object.sources
  ) {
    const { kind, ...evidence } = object;
    return {
      ...evidence,
      display: kind === "lhs" || kind === "rhs" ? kind : "both",
    };
  }
  let upgraded: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(object)) {
    const next = upgradeStoredEvidence(child);
    if (next !== child) (upgraded ??= { ...object })[key] = next;
  }
  return upgraded ?? value;
}
export const searchEvidenceSchema = z.preprocess(
  upgradeStoredEvidence,
  searchResultDataSchema,
);

/** Authored evidence preserves the supplied diff sides and presentation. */
export const codeEvidenceSchema = z.union([sourceSchema, searchEvidenceSchema]);
export type CodeEvidence = Source | SearchResultData;

export type SourceRange = Pick<Source, "file" | "fromLine" | "toLine">;

/** Thrown by the pure checks; each boundary translates it for its clients. */
export class SourceRangeError extends Error {}

/** Git and jj read committed objects, so a lexical check suffices: nothing
 * here follows a working-copy symlink. An empty string names the root. */
export function checkSourcePath(file: string): void {
  if (
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").some((part) => part === ".." || part === ".") ||
    /[\u0000-\u001f]/.test(file)
  )
    throw new SourceRangeError(
      "Source file must be a repository-relative path.",
    );
}

/** The range's text from a whole file. A trailing newline is not a line. */
export function sliceSourceRange(text: string, range: SourceRange): string {
  const lines = text.split(/\r?\n/);

  if (text.endsWith("\n")) lines.pop();

  if (text === "" || range.toLine > lines.length)
    throw new SourceRangeError(
      `Source range ${range.file}:${range.fromLine}-${range.toLine} exceeds the pinned file (${lines.length} lines).`,
    );

  return lines.slice(range.fromLine - 1, range.toLine).join("\n");
}

/** A source shown as a peek must contain visible text; a whitespace-only
 * range is an authoring mistake. Prose links may point at blank lines, so
 * only peek-rendering references call this. */
export function requireVisibleSource(text: string, range: SourceRange): void {
  if (text.trim() === "")
    throw new SourceRangeError(
      `Source range ${range.file}:${range.fromLine}-${range.toLine} contains only whitespace.`,
    );
}

/** The authoring input names the diff side `graph`; the document names it
 * `side`. */
export function codePeekSource(props: {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "head" | "base";
}): Source {
  return {
    side: props.graph ?? "head",
    file: props.file,
    fromLine: props.fromLine,
    toLine: props.toLine,
  };
}

/** Coordinate projections are only for navigation/coverage, never display reconstruction. */
export function evidenceSources(evidence: CodeEvidence): Source[] {
  if (!("display" in evidence)) return [evidence];
  const ranges: Source[] = [];
  for (const [key, side] of [
    ["lhs", "base"],
    ["rhs", "head"],
  ] as const) {
    if (evidence.display !== "both" && evidence.display !== key) continue;
    const source = evidence.sources.same ?? evidence.sources[key];
    const file = evidence.file[key];
    if (!source || !file) continue;
    const walk = (regions: RegionData[]) => {
      for (const region of regions) {
        if (region.visibility?.collapsed) continue;
        if (region.kind === "fold") walk(region.children);
        else {
          const toLine = region.end.line + Number(region.end.column > 0);
          if (toLine > region.start.line)
            ranges.push({
              side,
              file: file.path,
              fromLine: region.start.line + 1,
              toLine,
            });
        }
      }
    };
    walk(source.regions);
  }
  return ranges;
}

/** A navigation destination; it does not replace the displayed evidence. */
export function evidenceLocation(evidence: CodeEvidence): Source {
  if (!("display" in evidence)) return evidence;
  for (const [key, side] of [
    ["rhs", "head"],
    ["lhs", "base"],
  ] as const) {
    if (evidence.display !== "both" && evidence.display !== key) continue;
    const file = evidence.file[key],
      source = evidence.sources.same ?? evidence.sources[key];
    if (!file || !source) continue;
    const highlight = (regions: RegionData[]): number | undefined => {
      for (const region of regions) {
        if (region.visibility?.collapsed) continue;
        const line =
          region.kind === "fold"
            ? highlight(region.children)
            : region.search_highlights?.[0]?.line;
        if (line !== undefined) return line;
      }
    };
    const line = highlight(source.regions);
    if (line !== undefined)
      return { side, file: file.path, fromLine: line + 1, toLine: line + 1 };
  }
  const ranges = evidenceSources(evidence);
  const visible = ranges.find((range) => range.side === "head") ?? ranges[0];
  if (visible) return visible;
  const side =
    evidence.display !== "lhs" && evidence.file.rhs ? "head" : "base";
  const file = side === "head" ? evidence.file.rhs! : evidence.file.lhs!;
  return { side, file: file.path, fromLine: 1, toLine: 1 };
}

/** Preserve display payloads; coordinate projections are a separate concern. */
export function evidenceTargets(
  evidence: readonly CodeEvidence[],
): ReviewDiffLensTarget[] {
  return evidence.map((source) =>
    "display" in source
      ? { kind: "results", results: [source] }
      : { kind: "ranges", ranges: [source] },
  );
}
