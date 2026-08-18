import fs from "node:fs";
import path from "node:path";

import type { ResolvedSourceRange, SourceSnapshot } from "./source-code-types";
import { tokenizeSourceLine } from "./source-tokenizer";

export interface SourceRangeSpec {
  kind: "range";
  file: string;
  fromLine: number;
  toLine: number;
}

export interface ResolveSourceRangeInput {
  rootPath: string;
  root: SourceRangeSpec;
}

export function validateReviewSourceRange(
  input: ResolveSourceRangeInput,
): void {
  resolveSourceRange(input.rootPath, input.root);
}

export async function resolveReviewSourceRange(
  input: ResolveSourceRangeInput,
): Promise<SourceSnapshot> {
  const resolved = resolveSourceRange(input.rootPath, input.root);
  return createSourceSnapshot(resolved);
}

function resolveSourceRange(
  rootPath: string,
  input: SourceRangeSpec,
): ResolvedSourceRange {
  const { file, fromLine, toLine } = parseSourceRange(input);
  const absoluteRoot = path.resolve(rootPath);
  const absoluteFile = path.resolve(absoluteRoot, file);
  if (!isInsideDirectoryOrSame(absoluteFile, absoluteRoot)) {
    throw new Error("file must be inside the review root");
  }

  const relativeFile = path
    .relative(absoluteRoot, absoluteFile)
    .split(path.sep)
    .join("/");
  const sourceLines = fs.readFileSync(absoluteFile, "utf8").split(/\r?\n/);
  if (toLine > sourceLines.length) {
    throw new Error(
      `Source range ${relativeFile}:${fromLine}-${toLine} exceeds ${sourceLines.length} lines`,
    );
  }
  const sliced = sourceLines.slice(fromLine - 1, toLine);
  if (sliced.length === 0) {
    throw new Error(`No source lines found for ${relativeFile}:${fromLine}`);
  }
  const actualToLine = fromLine + sliced.length - 1;
  const id = `source-range:${relativeFile}:${fromLine}-${actualToLine}`;
  return {
    source: {
      id,
      name: `${path.basename(relativeFile)} L${fromLine}-L${actualToLine}`,
      kind: "source-range",
      file: relativeFile,
      line: fromLine,
      endLine: actualToLine,
    },
    lines: sliced.map((line) => tokenizeSourceLine(line)),
  };
}

function parseSourceRange(input: SourceRangeSpec): SourceRangeSpec {
  if (
    !input.file ||
    !Number.isInteger(input.fromLine) ||
    !Number.isInteger(input.toLine) ||
    input.fromLine < 1 ||
    input.toLine < input.fromLine ||
    input.toLine - input.fromLine > 400
  ) {
    throw new Error("invalid source range");
  }
  return input;
}

function createSourceSnapshot(resolved: ResolvedSourceRange): SourceSnapshot {
  const sourceId = resolved.source.id;
  return {
    roots: [{ kind: "source", sourceId }],
    resolved: { [sourceId]: resolved },
  };
}

function isInsideDirectoryOrSame(filePath: string, directory: string): boolean {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(filePath),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
