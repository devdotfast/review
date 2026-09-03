import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  detectLocalVcs,
  diff as readLocalVcsDiff,
  diffFileSummaries as readLocalVcsDiffFileSummaries,
  pathAttributesAtRevision,
} from "@dev.fast/local-vcs";

const REVIEW_FILE_CONTENT_LIMIT_BYTES = 5 * 1024 * 1024;

export interface ReviewDiffFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  generated?: boolean;
  patch?: string;
}

export interface ReviewDiffFilesResult {
  baseRef?: string;
  headRef?: string;
  files: ReviewDiffFile[];
}

export type ReviewFileContentResult =
  | { content: string; truncated?: boolean }
  | { absent: true }
  | { binary: true };

export async function resolveReviewDiffFiles(input: {
  rootPath: string;
  baseRef?: string;
  headRef?: string;
  contextLines?: number;
  includePatch?: boolean;
  paths?: string[];
}): Promise<ReviewDiffFilesResult> {
  const baseRef = input.baseRef?.trim();
  if (!baseRef) return { files: [] };

  const headRef = input.headRef?.trim() || undefined;
  const paths = normalizeDiffPaths(input.paths);
  let files: ReviewDiffFile[];
  if (input.includePatch === false) {
    files = await readLocalVcsDiffFileSummaries({
      rootPath: input.rootPath,
      baseRef,
      headRef,
      paths,
    });
  } else {
    const stdout = await readDiffOutput(
      input.rootPath,
      baseRef,
      headRef,
      paths,
      input.contextLines,
    );
    files = splitGitDiffSections(stdout)
      .map(parseReviewDiffFile)
      .filter((file): file is ReviewDiffFile => file !== null)
      .filter((file) => matchesDiffPath(file, paths));
  }

  return {
    baseRef,
    headRef,
    files: await classifyReviewDiffFiles({
      rootPath: input.rootPath,
      baseRef,
      headRef,
      files,
    }),
  };
}

const REVIEW_FILE_ATTRIBUTES = ["linguist-generated"] as const;

async function classifyReviewDiffFiles(input: {
  rootPath: string;
  baseRef: string;
  headRef: string | undefined;
  files: ReviewDiffFile[];
}): Promise<ReviewDiffFile[]> {
  // A live-working-tree comparison has no immutable attribute source. Review
  // sessions always pin a head, so leave the legacy working-tree route
  // unclassified instead of consulting mutable checkout metadata.
  if (!input.headRef || input.files.length === 0) return input.files;

  const headPaths = input.files
    .filter((file) => file.status !== "deleted")
    .map((file) => file.path);
  const deletedFiles = input.files.filter((file) => file.status === "deleted");
  const vcs = await detectLocalVcs(input.rootPath);
  const baseRef =
    (await vcs?.mergeBase(input.baseRef, input.headRef).catch(() => null))
      ?.commit ?? input.baseRef;
  const [headAttributes, baseAttributes] = await Promise.all([
    pathAttributesAtRevision({
      rootPath: input.rootPath,
      ref: input.headRef,
      paths: headPaths,
      attributes: [...REVIEW_FILE_ATTRIBUTES],
    }),
    pathAttributesAtRevision({
      rootPath: input.rootPath,
      ref: baseRef,
      paths: deletedFiles.map((file) => file.previousPath ?? file.path),
      attributes: [...REVIEW_FILE_ATTRIBUTES],
    }),
  ]);
  const byPath = new Map(
    [...headAttributes, ...baseAttributes].map((entry) => [
      entry.path,
      entry.attributes,
    ]),
  );
  return input.files.map((file) => {
    const attributes = byPath.get(
      file.status === "deleted" ? (file.previousPath ?? file.path) : file.path,
    );
    const generated = gitAttributeEnabled(attributes?.["linguist-generated"]);
    return {
      ...file,
      ...(generated ? { generated: true } : {}),
    };
  });
}

function gitAttributeEnabled(value: string | undefined): boolean {
  return value === "set" || value?.toLowerCase() === "true";
}

export async function resolveReviewFileContent(input: {
  rootPath: string;
  baseRef?: string;
  headRef?: string;
  path: string;
  side: "base" | "head";
  maxBytes?: number;
  comparison?: ReviewDiffFilesResult;
}): Promise<ReviewFileContentResult> {
  const requestedPath = input.path.trim();
  if (!requestedPath) throw new Error("A changed file path is required.");
  const comparison =
    input.comparison ??
    (await resolveReviewDiffFiles({
      rootPath: input.rootPath,
      baseRef: input.baseRef,
      headRef: input.headRef,
      includePatch: false,
    }));
  const file = comparison.files.find((entry) => entry.path === requestedPath);
  if (!file) {
    throw new Error(
      `File is not present in the current diff: ${requestedPath}`,
    );
  }

  if (input.side === "base" && file.status === "added") {
    return { absent: true };
  }
  if (input.side === "head" && file.status === "deleted") {
    return { absent: true };
  }

  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  const relativePath =
    input.side === "base" && file.status === "renamed"
      ? (file.previousPath ?? file.path)
      : file.path;
  const limit = input.maxBytes ?? REVIEW_FILE_CONTENT_LIMIT_BYTES;

  if (input.side === "head" && !comparison.headRef) {
    const absolutePath = resolveRepoFilePath(vcs.rootPath, relativePath);
    try {
      return fileContentFromBytes(await readFile(absolutePath), limit);
    } catch (error) {
      if (isMissingFileError(error)) return { absent: true };
      throw error;
    }
  }

  let revision = comparison.headRef;
  if (input.side === "base") {
    if (!comparison.baseRef) throw new Error("A base revision is required.");
    if (comparison.headRef) {
      const mergeBase = await vcs.mergeBase(
        comparison.baseRef,
        comparison.headRef,
      );
      if (!mergeBase) {
        throw new Error(
          `Could not resolve the merge base for ${comparison.baseRef}...${comparison.headRef}.`,
        );
      }
      revision = mergeBase.commit;
    } else {
      revision = comparison.baseRef;
    }
  }
  if (!revision) throw new Error("A file revision is required.");

  const content = await vcs.readFileAtRef(revision, relativePath);
  return content === null
    ? { absent: true }
    : fileContentFromBytes(Buffer.from(content, "utf8"), limit);
}

function resolveRepoFilePath(rootPath: string, relativePath: string): string {
  const absolutePath = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`File path escapes the repository: ${relativePath}`);
  }
  return absolutePath;
}

function fileContentFromBytes(
  bytes: Buffer,
  limit: number,
): ReviewFileContentResult {
  if (bytes.includes(0)) return { binary: true };
  if (bytes.byteLength <= limit) return { content: bytes.toString("utf8") };
  return {
    content: bytes.subarray(0, limit).toString("utf8"),
    truncated: true,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readDiffOutput(
  rootPath: string,
  baseRef: string,
  headRef: string | undefined,
  paths: string[],
  contextLines: number | undefined,
): Promise<string> {
  return readLocalVcsDiff({
    rootPath,
    baseRef,
    headRef,
    paths,
    contextLines,
  });
}

function normalizeDiffPaths(paths: string[] | undefined): string[] {
  return [
    ...new Set(
      (paths ?? [])
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    ),
  ].sort();
}

function matchesDiffPath(file: ReviewDiffFile, paths: string[]): boolean {
  if (paths.length === 0) return true;
  const candidates = new Set([file.path, file.previousPath].filter(Boolean));
  return paths.some((path) => candidates.has(path));
}

function splitGitDiffSections(diff: string): string[] {
  const sections: string[] = [];
  let current: string[] | null = null;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    current?.push(line);
  }

  if (current) sections.push(current.join("\n"));
  return sections.filter((section) => section.trim().length > 0);
}

function parseReviewDiffFile(section: string): ReviewDiffFile | null {
  const lines = section.split(/\r?\n/);
  const headerPaths = parseDiffGitHeaderPaths(lines[0] ?? "");
  let oldPath: string | null = headerPaths?.oldPath ?? null;
  let newPath: string | null = headerPaths?.newPath ?? null;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    const parsedOldPath = parseGitFileLine(line, "--- ");
    const parsedNewPath = parseGitFileLine(line, "+++ ");
    if (parsedOldPath !== undefined) oldPath = parsedOldPath;
    if (parsedNewPath !== undefined) newPath = parsedNewPath;
    if (line.startsWith("rename from ")) {
      renameFrom = unquoteGitPath(line.slice("rename from ".length).trim());
    }
    if (line.startsWith("rename to ")) {
      renameTo = unquoteGitPath(line.slice("rename to ".length).trim());
    }
    if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
  }

  const status = section.includes("\nnew file mode ")
    ? "added"
    : section.includes("\ndeleted file mode ")
      ? "deleted"
      : section.includes("\nrename from ") && section.includes("\nrename to ")
        ? "renamed"
        : "modified";
  const path =
    status === "deleted" ? oldPath : renameTo ? renameTo : (newPath ?? oldPath);

  if (!path) return null;

  return {
    path,
    previousPath:
      status === "renamed" ? (renameFrom ?? oldPath ?? undefined) : undefined,
    status,
    additions,
    deletions,
    patch: section,
  };
}

function parseDiffGitHeaderPaths(
  line: string,
): { oldPath: string; newPath: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const tokens = line.slice("diff --git ".length).match(/"([^"\\]|\\.)*"|\S+/g);
  if (!tokens || tokens.length < 2) return null;
  return {
    oldPath: stripDiffPathPrefix(unquoteGitPath(tokens[0])),
    newPath: stripDiffPathPrefix(unquoteGitPath(tokens[1])),
  };
}

function parseGitFileLine(
  line: string,
  prefix: "--- " | "+++ ",
): string | null | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const raw = unquoteGitPath(line.slice(prefix.length).trim());
  if (raw === "/dev/null") return null;
  return stripDiffPathPrefix(raw);
}

function stripDiffPathPrefix(value: string): string {
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith(`"`)) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, value.endsWith(`"`) ? -1 : undefined);
  }
}
