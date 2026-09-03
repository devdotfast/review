import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { git, gitArgsSync, gitCommonDirSync } from "@dev.fast/local-vcs";

import { devFastGitDir } from "./review-storage";
import {
  type SoftwareMapArtifactRole,
  canonicalizeModelImport,
  localizeModelImport,
  readSoftwareMapSourceForRef,
  scratchSoftwareMapPath,
  writeFileIfChangedSync,
} from "./software-map-artifact";
import {
  collectSoftwareMapCoverageErrors,
  normalizeClaimedPath,
} from "./software-map-coverage-validation";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";

export interface SoftwareMapSourceCheck {
  canonicalSource: string;
  model: NormalizedSoftwareModel | null;
  errors: string[];
}

// The one validation body behind `review map check` and the publish map-health
// gate. Both callers run this exact function, so "healthy at check" and
// "healthy at publish" cannot drift apart.
export async function checkSoftwareMapSource(input: {
  repoRootPath: string;
  commit: string;
  source: string;
  sourceName: string;
}): Promise<SoftwareMapSourceCheck> {
  // Validate the canonicalized form — the exact bytes a flush publishes —
  // so check-validated bytes and flushed bytes stay the same bytes.
  const canonicalSource = canonicalizeModelImport(input.source);

  let model: NormalizedSoftwareModel;
  try {
    model = await loadSoftwareMap(
      input.repoRootPath,
      canonicalSource,
      input.sourceName,
    );
  } catch (error) {
    return {
      canonicalSource,
      model: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  // Coverage claims are validated against the TARGET COMMIT'S TREE, never the
  // current checkout: a base map must not fail because the checkout has since
  // deleted a file. This is uniform — even when the target is the working
  // copy's current commit — so there is exactly one frame of reference, and
  // the errors name it.
  const treeFiles = await listCommitTreeFiles(input.repoRootPath, input.commit);
  const filesToRead = [
    ...new Set(
      model.elements.flatMap((element) =>
        (element.coverage?.files ?? [])
          .filter((file) => file.ranges.length > 0)
          .map((file) => normalizeClaimedPath(file.path)),
      ),
    ),
  ].filter((filePath) => treeFiles.includes(filePath));
  const treeFileContents = readCommitTreeFilesSync(
    input.repoRootPath,
    input.commit,
    filesToRead,
  );
  const errors = [
    // An element-free model is the unauthored schema stub; green-lighting it
    // would flush a stub note that ancestor hydration then propagates to
    // every descendant commit.
    ...(model.elements.length === 0
      ? [
          "the map is an unauthored stub (no people, systems, or elements); author it before check.",
        ]
      : []),
    ...collectSoftwareMapCoverageErrors({
      rootPath: input.repoRootPath,
      model,
      listFiles: () => treeFiles,
      readFile: (_rootPath, filePath) => {
        const source = treeFileContents.get(filePath);
        if (source === undefined) {
          throw new Error(`Commit tree file is missing: ${filePath}`);
        }
        return source;
      },
      pathsFrame: `tree of ${input.commit.slice(0, 12)}`,
    }),
  ];
  return { canonicalSource, model, errors };
}

export interface PublishSoftwareMaps {
  head: NormalizedSoftwareModel | null;
  base: NormalizedSoftwareModel | null;
  errors: string[];
}

export async function loadPublishSoftwareMaps(input: {
  repoRootPath: string;
  baseCommit: string;
  headCommit: string;
}): Promise<PublishSoftwareMaps> {
  const targets: Array<[SoftwareMapArtifactRole, string]> = [
    ["base", input.baseCommit],
    ["head", input.headCommit],
  ];
  const errors: string[] = [];
  let head: NormalizedSoftwareModel | null = null;
  let base: NormalizedSoftwareModel | null = null;
  for (const [role, commit] of targets) {
    const short = commit.slice(0, 12);
    const read = await readSoftwareMapSourceForRef({
      repoRootPath: input.repoRootPath,
      ref: commit,
      role,
    });
    if (!read) {
      errors.push(
        `No software map note at ${role} commit ${short}. Run \`review map open ${short}\`, author the map, then \`review map check ${short}\` and \`review map push\`.`,
      );
      continue;
    }
    const scratchPath = scratchSoftwareMapPath({
      repoRootPath: input.repoRootPath,
      commit: read.commit,
    });
    if (scratchPath) {
      const scratch = await readFile(scratchPath, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (
        scratch !== null &&
        canonicalizeModelImport(scratch) !==
          canonicalizeModelImport(read.source)
      ) {
        errors.push(
          `The ${role} software map scratch has unflushed changes. Run \`review map check ${commit.slice(0, 12)}\` first.`,
        );
        continue;
      }
    }
    const check = await checkSoftwareMapSource({
      repoRootPath: input.repoRootPath,
      commit: read.commit,
      source: read.source,
      sourceName: "software-map.ts",
    });
    for (const error of check.errors) {
      errors.push(
        `Software map at ${role} commit ${short} fails \`review map check\`: ${error}`,
      );
    }
    if (check.errors.length === 0 && check.model) {
      if (role === "head") head = check.model;
      else base = check.model;
    }
  }
  return { head, base, errors };
}

export async function loadSoftwareMap(
  rootPath: string,
  source: string,
  mapPath: string,
): Promise<NormalizedSoftwareModel> {
  const model = await importWithLocalizedModelImport({
    rootPath,
    source,
    basename: path.basename(mapPath),
  });
  if (!model) {
    throw new Error(`${mapPath} must default-export defineSoftwareMap({...}).`);
  }
  return model;
}

// The source carries the canonical package specifier, which does not resolve
// from inside a git dir — localize the import into a check-cache copy (strict
// model, unlike the tolerant materialized artifacts) and import that. The
// SOURCE is passed in (the exact bytes the caller validated), never re-read
// from disk here.
async function importWithLocalizedModelImport(input: {
  rootPath: string;
  source: string;
  basename: string;
}): Promise<NormalizedSoftwareModel | null> {
  const gitDir = gitCommonDirSync(input.rootPath);
  if (!gitDir) throw new Error(`No git repository found at ${input.rootPath}`);
  // The check copy lives in a per-invocation directory (pid + random): a
  // shared path would let concurrent checks of different commits race each
  // other and publish never-validated bytes.
  const checkDir = path.join(
    devFastGitDir(gitDir),
    "check",
    `${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const checkPath = path.join(checkDir, input.basename);
  mkdirSync(checkDir, { recursive: true });
  try {
    writeFileIfChangedSync(
      checkPath,
      localizeModelImport({
        source: input.source,
        outputPath: checkPath,
        modelFile: "software-map-model.ts",
      }),
    );
    const url = pathToFileURL(checkPath);
    url.searchParams.set("t", String(Date.now()));
    const module: { default?: unknown; softwareMap?: unknown } = await import(
      url.href
    );
    const model = module.default ?? module.softwareMap;
    return isNormalizedSoftwareModel(model) ? model : null;
  } finally {
    rmSync(checkDir, { recursive: true, force: true });
  }
}

// Tree readers go through the shared git dir (gitArgs/git), never `-C
// <worktree>`, so they work from non-colocated jj workspaces too.
export async function listCommitTreeFiles(
  rootPath: string,
  commit: string,
): Promise<string[]> {
  const listed = await git(
    rootPath,
    ["ls-tree", "-r", "-z", "--name-only", commit],
    { allowFailure: true },
  );
  if (!listed.ok) return [];
  return listed.stdout.split("\0").filter(Boolean);
}

function readCommitTreeFilesSync(
  rootPath: string,
  commit: string,
  filePaths: readonly string[],
): Map<string, string> {
  if (filePaths.length === 0) return new Map();
  const output = execFileSync(
    "git",
    gitArgsSync(rootPath, ["cat-file", "--batch"]),
    {
      input: `${filePaths.map((filePath) => `${commit}:${filePath}`).join("\n")}\n`,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const contents = new Map<string, string>();
  let offset = 0;
  for (const filePath of filePaths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`Missing git object for ${filePath}.`);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const size = Number(header.split(" ").at(-1));
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid git object header for ${filePath}: ${header}`);
    }
    const start = headerEnd + 1;
    const end = start + size;
    contents.set(filePath, output.subarray(start, end).toString("utf8"));
    offset = end + 1;
  }
  return contents;
}
