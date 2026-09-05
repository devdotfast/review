import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { listTrackedFilesSync } from "@dev.fast/local-vcs";

import { softwareMapGlobMatches } from "./software-map-diff-counts";
import type {
  NormalizedSoftwareCoverage,
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
  SoftwareLineRange,
} from "./software-map-model";

export interface SoftwareMapCoverageValidationInput {
  rootPath: string;
  model: NormalizedSoftwareModel;
  listFiles?: (rootPath: string) => readonly string[];
  readFile?: (rootPath: string, filePath: string) => string;
  /**
   * Names the frame of reference the file listing came from, so errors say
   * which tree was consulted (e.g. `tree of abc123def456`). Defaults to the
   * working checkout's tracked files.
   */
  pathsFrame?: string;
}

export function collectSoftwareMapCoverageErrors(
  input: SoftwareMapCoverageValidationInput,
) {
  const listFiles = input.listFiles ?? listTrackedFiles;
  const readFile = input.readFile ?? readTrackedFile;
  const pathsFrame = input.pathsFrame ?? "the tracked files";
  const trackedFiles = listFiles(input.rootPath).map(normalizeClaimedPath);
  const trackedFileSet = new Set(trackedFiles);
  const lineCountCache = new Map<string, number>();
  const errors: string[] = [];

  for (const element of input.model.elements) {
    if (!element.coverage) continue;

    for (const file of element.coverage.files) {
      const filePath = normalizeClaimedPath(file.path);
      if (!trackedFileSet.has(filePath)) {
        errors.push(
          `SoftwareMap coverage: "${element.path}" claims file "${file.path}" missing from ${pathsFrame}.`,
        );
        continue;
      }

      if (file.ranges.length === 0) continue;
      const lineCount = getTrackedFileLineCount({
        rootPath: input.rootPath,
        filePath,
        readFile,
        cache: lineCountCache,
      });
      if (lineCount === undefined) {
        errors.push(
          `SoftwareMap coverage: "${element.path}" claims unreadable file "${file.path}" in ${pathsFrame}.`,
        );
        continue;
      }

      for (const range of file.ranges) {
        if (range.toLine <= lineCount) continue;
        errors.push(
          `SoftwareMap coverage: "${element.path}" range ${range.fromLine}-${range.toLine} exceeds "${file.path}" length (${lineCount} lines).`,
        );
      }
    }

    for (const glob of element.coverage.globs) {
      const normalizedGlob = normalizeClaimedPath(glob);
      if (
        trackedFiles.some((filePath) =>
          softwareMapGlobMatches(normalizedGlob, filePath),
        )
      ) {
        continue;
      }
      errors.push(
        `SoftwareMap coverage: "${element.path}" glob "${glob}" matches nothing in ${pathsFrame}.`,
      );
    }
  }

  for (const element of input.model.elements) {
    if (!element.coverage) continue;
    const parent = nearestAncestorWithCoverage(element, input.model);
    if (!parent?.coverage) continue;
    errors.push(
      ...collectNestedCoverageErrors({
        parent,
        child: element,
        trackedFiles,
      }),
    );
  }

  for (const overlap of collectNonNestedCoverageOverlaps({
    model: input.model,
    trackedFiles,
  })) {
    errors.push(nonNestedCoverageOverlapMessage(overlap));
  }

  return errors;
}

function nearestAncestorWithCoverage(
  element: NormalizedSoftwareElement,
  model: NormalizedSoftwareModel,
) {
  let parentPath = element.parentPath;
  while (parentPath) {
    const parent = model.elementsByPath.get(parentPath);
    if (!parent) return null;
    if (parent.coverage) return parent;
    parentPath = parent.parentPath;
  }
  return null;
}

function collectNestedCoverageErrors(input: {
  parent: NormalizedSoftwareElement;
  child: NormalizedSoftwareElement;
  trackedFiles: readonly string[];
}) {
  if (!input.parent.coverage || !input.child.coverage) return [];
  const errors: string[] = [];
  const parentCoverage = expandParentCoverage(input.parent.coverage, {
    trackedFiles: input.trackedFiles,
  });
  const childSpans = expandCoverageSpans(input.child.coverage, {
    trackedFiles: input.trackedFiles,
  });

  for (const span of childSpans) {
    const parentRanges = parentCoverage.get(span.file);
    if (!parentRanges) {
      errors.push(nestedCoverageError(input.parent, input.child, span));
      continue;
    }
    if (parentRanges.length === 0) continue;
    if (span.ranges.length === 0) {
      errors.push(nestedCoverageError(input.parent, input.child, span));
      continue;
    }
    if (rangesCoverRanges(parentRanges, span.ranges)) continue;
    errors.push(nestedCoverageError(input.parent, input.child, span));
  }

  return errors;
}

function nestedCoverageError(
  parent: NormalizedSoftwareElement,
  child: NormalizedSoftwareElement,
  span: CoverageSpan,
) {
  return `SoftwareMap coverage: "${parent.path}" must cover child "${child.path}" file "${span.file}" from child ${span.source}.`;
}

interface CoverageSpan {
  file: string;
  ranges: SoftwareLineRange[];
  source: string;
}

interface NonNestedCoverageOverlap {
  left: NormalizedSoftwareElement;
  right: NormalizedSoftwareElement;
  leftSpan: CoverageSpan;
  rightSpan: CoverageSpan;
}

interface ExpandedCoverage {
  spans: CoverageSpan[];
  spansByFile: ReadonlyMap<string, CoverageSpan[]>;
  canonical: ReadonlyMap<string, CanonicalCoverageRange>;
}

function collectNonNestedCoverageOverlaps(input: {
  model: NormalizedSoftwareModel;
  trackedFiles: readonly string[];
}) {
  const coveredElements = input.model.elements.filter(
    (
      element,
    ): element is NormalizedSoftwareElement & {
      coverage: NormalizedSoftwareCoverage;
    } => Boolean(element.coverage),
  );
  const expandedByPath = new Map(
    coveredElements.map((element) => [
      element.path,
      expandCoverageForComparison(element.coverage, input.trackedFiles),
    ]),
  );
  const elementsByFile = new Map<string, number[]>();
  for (let index = 0; index < coveredElements.length; index += 1) {
    const element = coveredElements[index];
    if (!element) continue;
    const coverage = expandedByPath.get(element.path);
    if (!coverage) continue;
    for (const file of coverage.spansByFile.keys()) {
      const indexes = elementsByFile.get(file) ?? [];
      indexes.push(index);
      elementsByFile.set(file, indexes);
    }
  }
  const candidatePairs = new Set<string>();
  for (const indexes of elementsByFile.values()) {
    for (let left = 0; left < indexes.length; left += 1) {
      for (let right = left + 1; right < indexes.length; right += 1) {
        candidatePairs.add(`${indexes[left]}:${indexes[right]}`);
      }
    }
  }
  const overlaps: NonNestedCoverageOverlap[] = [];

  for (let leftIndex = 0; leftIndex < coveredElements.length; leftIndex += 1) {
    const left = coveredElements[leftIndex];
    if (!left) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < coveredElements.length;
      rightIndex += 1
    ) {
      const right = coveredElements[rightIndex];
      if (!right) continue;
      if (!candidatePairs.has(`${leftIndex}:${rightIndex}`)) continue;
      if (
        isAncestor(left, right, input.model) ||
        isAncestor(right, left, input.model)
      ) {
        continue;
      }

      const leftCoverage = expandedByPath.get(left.path);
      const rightCoverage = expandedByPath.get(right.path);
      if (!leftCoverage || !rightCoverage) continue;
      const firstOverlap = findFirstCoverageOverlap(
        leftCoverage,
        rightCoverage,
      );
      if (!firstOverlap) continue;
      overlaps.push({
        left,
        right,
        ...firstOverlap,
      });
    }
  }

  return overlaps;
}

function expandCoverageForComparison(
  coverage: NormalizedSoftwareCoverage,
  trackedFiles: readonly string[],
): ExpandedCoverage {
  const spans = expandCoverageSpans(coverage, { trackedFiles });
  const spansByFile = new Map<string, CoverageSpan[]>();
  for (const span of spans) {
    const fileSpans = spansByFile.get(span.file) ?? [];
    fileSpans.push(span);
    spansByFile.set(span.file, fileSpans);
  }
  return {
    spans,
    spansByFile,
    canonical: canonicalizeCoverageSpans(spans),
  };
}

function isAncestor(
  possibleAncestor: NormalizedSoftwareElement,
  descendant: NormalizedSoftwareElement,
  model: NormalizedSoftwareModel,
) {
  let parentPath = descendant.parentPath;
  while (parentPath) {
    if (parentPath === possibleAncestor.path) return true;
    parentPath = model.elementsByPath.get(parentPath)?.parentPath;
  }
  return false;
}

function findFirstCoverageOverlap(
  leftCoverage: ExpandedCoverage,
  rightCoverage: ExpandedCoverage,
) {
  for (const leftSpan of leftCoverage.spans) {
    for (const rightSpan of rightCoverage.spansByFile.get(leftSpan.file) ??
      []) {
      if (!coverageRangesOverlap(leftSpan.ranges, rightSpan.ranges)) continue;
      return { leftSpan, rightSpan };
    }
  }
  return null;
}

function coverageRangesOverlap(
  left: readonly SoftwareLineRange[],
  right: readonly SoftwareLineRange[],
) {
  if (left.length === 0 || right.length === 0) return true;
  return left.some((leftRange) =>
    right.some(
      (rightRange) =>
        leftRange.fromLine <= rightRange.toLine &&
        rightRange.fromLine <= leftRange.toLine,
    ),
  );
}

type CanonicalCoverageRange = SoftwareLineRange[] | "entire-file";

function canonicalizeCoverageSpans(spans: readonly CoverageSpan[]) {
  const result = new Map<string, CanonicalCoverageRange>();
  for (const span of spans) {
    const current = result.get(span.file);
    if (current === "entire-file") continue;
    if (span.ranges.length === 0) {
      result.set(span.file, "entire-file");
      continue;
    }
    result.set(
      span.file,
      mergeCoverageRanges([...(current ?? []), ...span.ranges]),
    );
  }
  return result;
}

function mergeCoverageRanges(ranges: readonly SoftwareLineRange[]) {
  const result: SoftwareLineRange[] = [];
  const sorted = [...ranges].sort(
    (left, right) =>
      left.fromLine - right.fromLine || left.toLine - right.toLine,
  );
  for (const range of sorted) {
    const previous = result.at(-1);
    if (!previous || range.fromLine > previous.toLine + 1) {
      result.push({ ...range });
      continue;
    }
    previous.toLine = Math.max(previous.toLine, range.toLine);
  }
  return result;
}

function nonNestedCoverageOverlapMessage(overlap: NonNestedCoverageOverlap) {
  return `SoftwareMap coverage: "${overlap.left.path}" and "${overlap.right.path}" overlap on file "${overlap.leftSpan.file}" from ${overlap.leftSpan.source} and ${overlap.rightSpan.source}; non-nested elements must not share coverage.`;
}

function expandParentCoverage(
  coverage: NormalizedSoftwareCoverage,
  input: { trackedFiles: readonly string[] },
) {
  const result = new Map<string, SoftwareLineRange[]>();
  for (const span of expandCoverageSpans(coverage, input)) {
    const current = result.get(span.file);
    if (current?.length === 0) continue;
    if (span.ranges.length === 0) {
      result.set(span.file, []);
      continue;
    }
    result.set(span.file, [...(current ?? []), ...span.ranges]);
  }
  return result;
}

function expandCoverageSpans(
  coverage: NormalizedSoftwareCoverage,
  input: { trackedFiles: readonly string[] },
) {
  const spans: CoverageSpan[] = [];
  for (const file of coverage.files) {
    spans.push({
      file: normalizeClaimedPath(file.path),
      ranges: [...file.ranges],
      source: `file "${file.path}"`,
    });
  }
  for (const glob of coverage.globs) {
    const normalizedGlob = normalizeClaimedPath(glob);
    for (const filePath of input.trackedFiles) {
      if (!softwareMapGlobMatches(normalizedGlob, filePath)) continue;
      spans.push({
        file: filePath,
        ranges: [],
        source: `glob "${glob}"`,
      });
    }
  }
  return spans;
}

function rangesCoverRanges(
  parentRanges: readonly SoftwareLineRange[],
  childRanges: readonly SoftwareLineRange[],
) {
  const sortedParentRanges = [...parentRanges].sort(
    (left, right) => left.fromLine - right.fromLine,
  );
  for (const child of childRanges) {
    let nextLine = child.fromLine;
    for (const parent of sortedParentRanges) {
      if (parent.toLine < nextLine) continue;
      if (parent.fromLine > nextLine) return false;
      nextLine = Math.max(nextLine, parent.toLine + 1);
      if (nextLine > child.toLine) break;
    }
    if (nextLine <= child.toLine) return false;
  }
  return true;
}

function getTrackedFileLineCount(input: {
  rootPath: string;
  filePath: string;
  readFile: (rootPath: string, filePath: string) => string;
  cache: Map<string, number>;
}) {
  const cached = input.cache.get(input.filePath);
  if (cached !== undefined) return cached;

  try {
    const lineCount = countLines(
      input.readFile(input.rootPath, input.filePath),
    );
    input.cache.set(input.filePath, lineCount);
    return lineCount;
  } catch {
    return undefined;
  }
}

function countLines(source: string) {
  if (source.length === 0) return 0;
  return source
    .replace(/\r?\n$/, "")
    .replace(/\r$/, "")
    .split(/\r\n|\r|\n/).length;
}

function listTrackedFiles(rootPath: string) {
  const files = listTrackedFilesSync({ rootPath });
  return files.length > 0
    ? files
    : walkFiles(rootPath).map((filePath) => path.relative(rootPath, filePath));
}

function walkFiles(rootPath: string) {
  const ignoredNames = new Set([
    ".git",
    ".jj",
    ".next",
    ".turbo",
    ".wrangler",
    "build",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const files: string[] = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const directory = queue.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignoredNames.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile()) files.push(entryPath);
    }
  }

  return files;
}

function readTrackedFile(rootPath: string, filePath: string) {
  const absolutePath = path.resolve(rootPath, filePath);
  if (!statSync(absolutePath).isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
  return readFileSync(absolutePath, "utf8");
}

export function normalizeClaimedPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
