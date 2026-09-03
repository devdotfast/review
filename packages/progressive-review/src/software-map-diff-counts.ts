import { diff as readLocalVcsDiff } from "@dev.fast/local-vcs";

import { type DiffHunkLine, parseUnifiedPatch } from "./unified-diff";

export interface SoftwareMapDiffLineCount {
  additions: number;
  deletions: number;
}

export interface SoftwareMapCoverageFileInput {
  path: string;
  ranges?: SoftwareMapLineRangeInput[];
}

export interface SoftwareMapCoverageClaimInput {
  path: string;
  files?: SoftwareMapCoverageFileInput[];
  globs?: string[];
}

export interface SoftwareMapLineRangeInput {
  fromLine: number;
  toLine: number;
}

export interface SoftwareMapCodeElementInput {
  path: string;
  label?: string;
  description?: string;
  changeStatus?: "added" | "removed" | "modified" | "unchanged";
  sourceRanges?: Array<SoftwareMapLineRangeInput & { file: string }>;
}

export interface SoftwareMapUnmappedDiffLine {
  kind: "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface SoftwareMapUnmappedDiffHunk {
  startLine: number;
  lines: SoftwareMapUnmappedDiffLine[];
}

export interface SoftwareMapUnmappedDiffFile extends SoftwareMapDiffLineCount {
  file: string;
  hunks: SoftwareMapUnmappedDiffHunk[];
}

export interface SoftwareMapUnmappedDiffSummary extends SoftwareMapDiffLineCount {
  files: SoftwareMapUnmappedDiffFile[];
}

export type SoftwareMapDiffCountsByElementPath = Record<
  string,
  SoftwareMapDiffLineCount
>;

export type SoftwareMapUnmappedDiffByElementPath = Record<
  string,
  SoftwareMapUnmappedDiffSummary
>;

export interface SoftwareMapDiffCountsResult {
  baseRef?: string;
  headRef?: string;
  countsByElementPath: SoftwareMapDiffCountsByElementPath;
  unmappedByElementPath: SoftwareMapUnmappedDiffByElementPath;
}

export interface ResolveSoftwareMapDiffCountsInput {
  sourceRootPath: string;
  baseRef?: string;
  headRef?: string;
  codeElements: SoftwareMapCodeElementInput[];
  coverageClaims?: SoftwareMapCoverageClaimInput[];
}

interface FileLineChange extends SoftwareMapDiffLineCount {
  rows: SoftwareMapUnmappedDiffLine[];
}

type FileLineCounts = Map<string, Map<number, FileLineChange>>;

export async function resolveSoftwareMapDiffCounts(
  input: ResolveSoftwareMapDiffCountsInput,
): Promise<SoftwareMapDiffCountsResult> {
  const baseRef = input.baseRef?.trim();
  if (!baseRef) {
    return { countsByElementPath: {}, unmappedByElementPath: {} };
  }
  const headRef = input.headRef?.trim() || undefined;
  const sourceRootPath = input.sourceRootPath;

  const diff = await readLocalVcsDiff({
    rootPath: sourceRootPath,
    baseRef,
    headRef,
    contextLines: 0,
  }).catch(() => "");
  if (!diff.trim()) {
    return {
      baseRef,
      headRef,
      countsByElementPath: {},
      unmappedByElementPath: {},
    };
  }

  const countsByFile = parseGitUnifiedDiffLineCounts(diff);
  if (countsByFile.size === 0) {
    return {
      baseRef,
      headRef,
      countsByElementPath: {},
      unmappedByElementPath: {},
    };
  }

  const mapped = await mapDiffLineCountsToSoftwareMapElements({
    codeElements: input.codeElements,
    countsByFile,
  });

  const unmappedByElementPath = mapDiffLineCountsToCoverageClaims({
    coverageClaims: input.coverageClaims ?? [],
    countsByFile,
  });

  return {
    baseRef,
    headRef,
    countsByElementPath: mapped.countsByElementPath,
    unmappedByElementPath,
  };
}

export function parseGitUnifiedDiffLineCounts(diff: string): FileLineCounts {
  const countsByFile: FileLineCounts = new Map();

  for (const fileDiff of splitGitDiff(diff)) {
    const file = fileDiff.newFile ?? fileDiff.oldFile;
    if (!file) continue;

    for (const hunk of parseUnifiedPatch(file, fileDiff.patch)) {
      let currentNewLine = Math.max(1, hunk.newStart);
      for (const line of hunk.lines) {
        if (line.kind === "add" && line.newLine !== null) {
          addLineCount(countsByFile, file, line.newLine, "additions", line);
          currentNewLine = line.newLine + 1;
          continue;
        }

        if (line.kind === "remove") {
          addLineCount(countsByFile, file, currentNewLine, "deletions", line);
          continue;
        }

        if (line.newLine !== null) {
          currentNewLine = line.newLine + 1;
        }
      }
    }
  }

  return countsByFile;
}

export interface SoftwareMapElementDiffCounts {
  countsByElementPath: SoftwareMapDiffCountsByElementPath;
}

export function mapDiffLineCountsToSoftwareMapElements(input: {
  codeElements: SoftwareMapCodeElementInput[];
  countsByFile: FileLineCounts;
}): SoftwareMapElementDiffCounts {
  const countsByElementPath: SoftwareMapDiffCountsByElementPath = {};

  for (const element of input.codeElements) {
    const total: SoftwareMapDiffLineCount = { additions: 0, deletions: 0 };
    const countedLines = new Set<string>();
    for (const range of element.sourceRanges ?? []) {
      const fileCounts = input.countsByFile.get(range.file);
      if (!fileCounts) continue;
      for (const [line, counts] of fileCounts) {
        if (line < range.fromLine || line > range.toLine) continue;
        const lineKey = `${range.file}:${line}`;
        if (countedLines.has(lineKey)) continue;
        countedLines.add(lineKey);
        total.additions +=
          element.changeStatus === "removed" ? 0 : counts.additions;
        total.deletions +=
          element.changeStatus === "added" ? 0 : counts.deletions;
      }
    }

    if (total.additions > 0 || total.deletions > 0) {
      countsByElementPath[element.path] = total;
    }
  }

  return { countsByElementPath };
}

export function mapDiffLineCountsToCoverageClaims(input: {
  coverageClaims: SoftwareMapCoverageClaimInput[];
  countsByFile: FileLineCounts;
}) {
  const result: SoftwareMapUnmappedDiffByElementPath = {};
  const claims = input.coverageClaims
    .filter(
      (claim) =>
        (claim.files?.length ?? 0) > 0 || (claim.globs?.length ?? 0) > 0,
    )
    .sort(compareCoverageClaims);

  for (const [file, fileCounts] of input.countsByFile) {
    for (const [line, counts] of fileCounts) {
      for (const claim of claims) {
        if (!softwareMapCoverageClaimMatchesLine(claim, file, line)) continue;
        const summary = (result[claim.path] ??= {
          additions: 0,
          deletions: 0,
          files: [],
        });
        summary.additions += counts.additions;
        summary.deletions += counts.deletions;
        addUnmappedFileLine(summary, file, line, counts.rows);
      }
    }
  }

  return result;
}

function addLineCount(
  countsByFile: FileLineCounts,
  file: string,
  line: number,
  kind: keyof SoftwareMapDiffLineCount,
  diffLine: DiffHunkLine,
): void {
  const fileCounts = countsByFile.get(file) ?? new Map();
  const current = fileCounts.get(line) ?? {
    additions: 0,
    deletions: 0,
    rows: [],
  };
  current[kind] += 1;
  current.rows.push(toUnmappedDiffLine(diffLine));
  fileCounts.set(line, current);
  countsByFile.set(file, fileCounts);
}

function addUnmappedFileLine(
  summary: SoftwareMapUnmappedDiffSummary,
  file: string,
  line: number,
  rows: SoftwareMapUnmappedDiffLine[],
): void {
  let fileSummary = summary.files.find((candidate) => candidate.file === file);
  if (!fileSummary) {
    fileSummary = { file, additions: 0, deletions: 0, hunks: [] };
    summary.files.push(fileSummary);
  }
  for (const row of rows) {
    if (row.kind === "add") fileSummary.additions += 1;
    if (row.kind === "remove") fileSummary.deletions += 1;
  }
  const lastHunk = fileSummary.hunks.at(-1);
  if (lastHunk && line <= lastHunk.startLine + lastHunk.lines.length + 1) {
    lastHunk.lines.push(...rows);
  } else {
    fileSummary.hunks.push({ startLine: line, lines: [...rows] });
  }
}

function toUnmappedDiffLine(line: DiffHunkLine): SoftwareMapUnmappedDiffLine {
  return {
    kind: line.kind === "add" ? "add" : "remove",
    oldLine: line.oldLine,
    newLine: line.newLine,
    text: line.text,
  };
}

function compareCoverageClaims(
  left: SoftwareMapCoverageClaimInput,
  right: SoftwareMapCoverageClaimInput,
) {
  return coverageSpecificity(right) - coverageSpecificity(left);
}

function coverageSpecificity(claim: SoftwareMapCoverageClaimInput) {
  const pathDepth = claim.path.split(".").length * 1000;
  const exactFiles = (claim.files?.length ?? 0) * 20;
  const globs =
    claim.globs?.reduce((total, glob) => total + glob.length, 0) ?? 0;
  return pathDepth + exactFiles + globs;
}

export function softwareMapCoverageClaimMatchesLine(
  claim: SoftwareMapCoverageClaimInput,
  file: string,
  line: number,
) {
  for (const claimedFile of claim.files ?? []) {
    if (claimedFile.path !== file) continue;
    if (softwareMapLineInRanges(line, claimedFile.ranges)) return true;
  }
  return (claim.globs ?? []).some((glob) => softwareMapGlobMatches(glob, file));
}

export function softwareMapLineInRanges(
  line: number,
  ranges: SoftwareMapLineRangeInput[] = [],
) {
  if (ranges.length === 0) return true;
  return ranges.some((range) => line >= range.fromLine && line <= range.toLine);
}

const softwareMapGlobRegexes = new Map<string, RegExp>();

export function softwareMapGlobMatches(pattern: string, value: string) {
  let regex = softwareMapGlobRegexes.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${globToRegex(pattern)}$`);
    softwareMapGlobRegexes.set(pattern, regex);
  }
  return regex.test(value);
}

function globToRegex(pattern: string) {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      result += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      result += "[^/]*";
      continue;
    }
    if (char === "?") {
      result += "[^/]";
      continue;
    }
    result += escapeRegex(char);
  }
  return result;
}

function escapeRegex(char: string) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function splitGitDiff(
  diff: string,
): Array<{ oldFile: string | null; newFile: string | null; patch: string }> {
  const result: Array<{
    oldFile: string | null;
    newFile: string | null;
    patch: string;
  }> = [];
  let current: {
    oldFile: string | null;
    newFile: string | null;
    lines: string[];
  } | null = null;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        result.push({
          oldFile: current.oldFile,
          newFile: current.newFile,
          patch: current.lines.join("\n"),
        });
      }
      current = { oldFile: null, newFile: null, lines: [] };
      continue;
    }

    if (!current) continue;
    const oldFile = parseGitFileLine(line, "--- ");
    const newFile = parseGitFileLine(line, "+++ ");
    if (oldFile !== undefined) {
      current.oldFile = oldFile;
      continue;
    }
    if (newFile !== undefined) {
      current.newFile = newFile;
      continue;
    }
    current.lines.push(line);
  }

  if (current) {
    result.push({
      oldFile: current.oldFile,
      newFile: current.newFile,
      patch: current.lines.join("\n"),
    });
  }

  return result;
}

function parseGitFileLine(
  line: string,
  prefix: "--- " | "+++ ",
): string | null | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const raw = unquoteGitPath(line.slice(prefix.length).trim());
  if (raw === "/dev/null") return null;
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith(`"`)) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, value.endsWith(`"`) ? -1 : undefined);
  }
}
