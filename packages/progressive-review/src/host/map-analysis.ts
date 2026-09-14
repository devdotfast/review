import { createHash } from "node:crypto";

import {
  HOST_RESOURCE_LIMITS,
  type HostBinding,
  type HostMapAnalysis,
  type HostMapAnalysisInput,
  HostMapAnalysisSchema,
  type HostMapElementAnalysis,
  type HostMapVersion,
  type HostSourceSpan,
  canonicalHostJson,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { type DiffHunk, parseUnifiedPatch } from "../unified-diff";
import { EvidenceProviderError } from "./evidence-provider";
import { HostStoreError } from "./review-host-store";

type Side = "base" | "head";
type Maps = Record<Side, HostMapVersion | null>;
type ChangedFile = {
  baseFile: string | null;
  headFile: string | null;
  hunks: DiffHunk[];
};

/** Analyze a saved graph, never a client-authored projection of it. Paging only
 * selects output rows: each row retains its complete own/descendant scope. */
export function analyzeMapChanges(input: {
  request: HostMapAnalysisInput;
  binding: HostBinding;
  maps: Maps;
  patch: string;
}): HostMapAnalysis {
  const { request, binding, maps } = input;
  if (Buffer.byteLength(input.patch) > HOST_RESOURCE_LIMITS.analysisDiffBytes)
    limit("Map analysis diff exceeds 16 MiB.");
  const mapVersions = {
    base: maps.base?.id ?? null,
    head: maps.head?.id ?? null,
  };
  const allIds = new Set([
    ...Object.keys(maps.base?.elements ?? {}),
    ...Object.keys(maps.head?.elements ?? {}),
  ]);
  const selected = request.elementIds ?? [...allIds];
  if (
    new Set(selected).size !== selected.length ||
    (request.elementIds && !selected.length)
  )
    fail("INVALID_REQUEST", "Select unique, nonempty map element IDs.");
  if (selected.some((id) => !allIds.has(id)))
    fail("NOT_FOUND", "A selected element is absent from the saved maps.");
  const ids = [...selected].sort();
  const scope = createHash("sha256")
    .update(
      canonicalHostJson({
        reviewId: request.reviewId,
        reviewVersion: request.reviewVersion,
        mapVersions,
        elementIds: request.elementIds ? ids : null,
        includeDiff: request.includeDiff ?? false,
      }),
    )
    .digest("hex");
  const start = pageStart(request.cursor, scope, ids);
  const page = ids.slice(start, start + (request.limit ?? 100));
  const files = parseAnalysisPatch(input.patch);
  const collect = {
    base: sourceCollector(maps.base),
    head: sourceCollector(maps.head),
  };
  const both = maps.base !== null && maps.head !== null;
  let checks = 0;
  const check = () => {
    if (++checks > HOST_RESOURCE_LIMITS.analysisRangeChecks)
      limit(
        "Map attribution exceeds 2,000,000 changed-row/range checks; request fewer elements.",
      );
  };
  const items: HostMapElementAnalysis[] = [];
  let responseBytes = 0;
  for (const elementId of page) {
    const presence = {
      base: !!maps.base?.elements[elementId],
      head: !!maps.head?.elements[elementId],
    };
    const sources = {
      base: collect.base(elementId),
      head: collect.head(elementId),
    };
    const detail: NonNullable<HostMapElementAnalysis["diff"]> = { files: [] };
    let additions = 0,
      deletions = 0;
    for (const file of files) {
      const matching = {
        base: sources.base.filter((range) => range.file === file.baseFile),
        head: sources.head.filter((range) => range.file === file.headFile),
      };
      const hunks: NonNullable<
        HostMapElementAnalysis["diff"]
      >["files"][number]["hunks"] = [];
      for (const hunk of file.hunks) {
        const lines: (typeof hunks)[number]["lines"] = [];
        let boundary = false;
        for (const line of hunk.lines) {
          if (line.kind === "context") continue;
          const side: Side = line.kind === "add" ? "head" : "base";
          const coordinate = side === "head" ? line.newLine : line.oldLine;
          let attribution: "overlap" | "boundary" | null = null;
          if (
            coordinate !== null &&
            matching[side].some((range) => {
              check();
              return coordinate >= range.fromLine && coordinate <= range.toLine;
            })
          )
            attribution = "overlap";
          // A single-side view still shows the other half of an edit that
          // overlaps its saved source. An empty range is an edit boundary,
          // never fabricated source coordinates or retained evidence.
          if (!attribution && !both) {
            const other: Side = side === "head" ? "base" : "head";
            const from = other === "head" ? hunk.newStart : hunk.oldStart;
            const count = other === "head" ? hunk.newLines : hunk.oldLines;
            if (
              matching[other].some((range) => {
                check();
                return count === 0
                  ? from >= range.fromLine - 1 && from <= range.toLine
                  : from <= range.toLine && from + count - 1 >= range.fromLine;
              })
            )
              attribution = count === 0 ? "boundary" : "overlap";
          }
          if (!attribution) continue;
          if (line.kind === "add") additions++;
          else deletions++;
          boundary ||= attribution === "boundary";
          if (request.includeDiff)
            lines.push({
              kind: line.kind,
              baseLine: line.oldLine,
              headLine: line.newLine,
              text: line.text,
            });
        }
        if (lines.length)
          hunks.push({
            baseRange: { startLine: hunk.oldStart, lineCount: hunk.oldLines },
            headRange: { startLine: hunk.newStart, lineCount: hunk.newLines },
            attribution: boundary ? "boundary" : "overlap",
            lines,
          });
      }
      if (hunks.length)
        detail.files.push({
          baseFile: file.baseFile,
          headFile: file.headFile,
          hunks,
        });
    }
    const item: HostMapElementAnalysis = {
      elementId,
      presence,
      additions,
      deletions,
      changeStatus:
        both && !presence.base
          ? "added"
          : both && !presence.head
            ? "removed"
            : additions + deletions > 0
              ? "modified"
              : "unchanged",
    };
    if (request.includeDiff) item.diff = detail;
    responseBytes += Buffer.byteLength(JSON.stringify(item));
    if (responseBytes > HOST_RESOURCE_LIMITS.analysisResponseBytes)
      limit(
        "Map analysis response exceeds 4 MiB; request fewer elements or omit detailed diff.",
      );
    items.push(item);
  }
  const nextCursor =
    start + page.length < ids.length
      ? Buffer.from(JSON.stringify({ scope, after: page.at(-1) })).toString(
          "base64url",
        )
      : null;
  const result = {
    reviewVersion: request.reviewVersion,
    mapVersions,
    comparison: {
      baseCommit: binding.baseCommit,
      headCommit: binding.headCommit,
    },
    items,
    nextCursor,
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) >
    HOST_RESOURCE_LIMITS.analysisResponseBytes
  )
    limit(
      "Map analysis response exceeds 4 MiB; request fewer elements or omit detailed diff.",
    );
  return HostMapAnalysisSchema.parse(result);
}

function sourceCollector(map: HostMapVersion | null) {
  const children = new Map<string, string[]>();
  for (const element of Object.values(map?.elements ?? {})) {
    if (element.parentId !== null) {
      const list = children.get(element.parentId) ?? [];
      list.push(element.id);
      children.set(element.parentId, list);
    }
  }
  return (id: string): HostSourceSpan[] => {
    const ranges = new Map<string, HostSourceSpan>();
    const visited = new Set<string>(),
      pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (visited.has(next)) continue;
      visited.add(next);
      for (const source of map?.elements[next]?.source ?? [])
        ranges.set(
          `${source.file}:${source.fromLine}:${source.toLine}`,
          source,
        );
      pending.push(...(children.get(next) ?? []));
    }
    return [...ranges.values()];
  };
}

function pageStart(cursor: string | undefined, scope: string, ids: string[]) {
  if (!cursor) return 0;
  try {
    const value = z
      .strictObject({ scope: z.string(), after: z.string() })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (value.scope !== scope) throw new Error();
    const index = ids.indexOf(value.after);
    if (index < 0) throw new Error();
    return index + 1;
  } catch {
    throw new HostStoreError(
      "CURSOR_EXPIRED",
      "Refresh the selected map analysis.",
    );
  }
}

function parseAnalysisPatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let baseFile: string | null = null,
    headFile: string | null = null;
  let body: string[] = [],
    inHunk = false;
  const flush = () => {
    if (body.length && (baseFile !== null || headFile !== null))
      files.push({
        baseFile,
        headFile,
        hunks: parseUnifiedPatch(headFile ?? baseFile!, body.join("\n")),
      });
    baseFile = headFile = null;
    body = [];
    inHunk = false;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      continue;
    }
    if (line.startsWith("@@ ")) inHunk = true;
    if (!inHunk && line.startsWith("--- "))
      baseFile = patchPath(line.slice(4), "a/");
    else if (!inHunk && line.startsWith("+++ "))
      headFile = patchPath(line.slice(4), "b/");
    else body.push(line);
  }
  flush();
  return files;
}

function patchPath(raw: string, prefix: string): string | null {
  // Git quotes unusual paths as C strings; core.quotepath=false keeps UTF-8
  // literal, while the allowed path grammar excludes octal-escaped controls.
  let value = raw;
  if (value.startsWith('"')) {
    try {
      value = z.string().parse(JSON.parse(value));
    } catch {
      fail(
        "DEPENDENCY_UNAVAILABLE",
        "The source diff path could not be decoded.",
      );
    }
  } else if (value.endsWith("\t")) value = value.slice(0, -1);
  if (value === "/dev/null") return null;
  if (!value.startsWith(prefix))
    fail("DEPENDENCY_UNAVAILABLE", "The source diff path is invalid.");
  return value.slice(prefix.length);
}

function limit(message: string): never {
  throw new EvidenceProviderError("RESOURCE_LIMIT", message);
}
function fail(
  code: "INVALID_REQUEST" | "NOT_FOUND" | "DEPENDENCY_UNAVAILABLE",
  message: string,
): never {
  throw new EvidenceProviderError(code, message);
}
