import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  detectLocalVcs,
  evologCommitIds,
  git,
  gitCommonDir,
  gitCommonDirSync,
  listNoteCommits,
  readNote,
  readNoteSync,
  remoteNotesRef,
  resolveRevision,
  resolveRevisionSync,
  writeNote,
  writeNoteSync,
} from "@dev.fast/local-vcs";

import {
  progressiveReviewModelModulePath,
  relativeImportPath,
} from "./package-paths";
import {
  SOFTWARE_MAP_FILE_NAME,
  SOFTWARE_MAP_NOTES_REF,
  materializedSoftwareMapDir,
  scratchSoftwareMapDir,
} from "./review-storage";

export { SOFTWARE_MAP_FILE_NAME, SOFTWARE_MAP_NOTES_REF };

export const CANONICAL_SOFTWARE_MAP_MODEL_IMPORT =
  "@dev.fast/progressive-review/software-map-model";

export type SoftwareMapArtifactRole = "head" | "base";

/**
 * Regex source matching the basenames an authored/materialized import may
 * reference (with or without an extension). The tolerant model spelling is
 * accepted too, so materialized artifacts round-trip back to the canonical
 * specifier.
 */
const MODEL_BASENAME_PATTERN = "(?:tolerant-)?software-map-model";

/**
 * Model module materialized artifacts import: the TOLERANT model, so an old
 * snapshot still renders after schema tightening.
 */
const MATERIALIZED_MODEL_FILE = "tolerant-software-map-model.ts";

/** Strict model module used for validation (never the tolerant one). */
const STRICT_MODEL_FILE = "software-map-model.ts";

export type SoftwareMapModelFile =
  | typeof MATERIALIZED_MODEL_FILE
  | typeof STRICT_MODEL_FILE;

// ---------------------------------------------------------------------------
// Import-line canonicalization
// ---------------------------------------------------------------------------
// Stored note content must be location-independent, so notes (and scratches,
// which are note-shaped) carry a canonical package specifier. Materialization
// rewrites it to a real module path for the artifact's on-disk location.

export function canonicalizeModelImport(source: string): string {
  return replaceModelImportSpecifiers(
    source,
    CANONICAL_SOFTWARE_MAP_MODEL_IMPORT,
  );
}

export function localizeModelImport(input: {
  source: string;
  outputPath: string;
  modelFile?: SoftwareMapModelFile;
  packageRoot?: string;
}): string {
  const modelPath = progressiveReviewModelModulePath(
    input.modelFile ?? MATERIALIZED_MODEL_FILE,
    input.packageRoot,
  );
  return replaceModelImportSpecifiers(
    input.source,
    relativeImportPath(input.outputPath, modelPath),
  );
}

function replaceModelImportSpecifiers(
  source: string,
  replacement: string,
): string {
  const pattern = new RegExp(
    `(from\\s+["'])((?:[^"']*/)?${MODEL_BASENAME_PATTERN}(?:\\.ts|\\.js)?|${escapeRegExp(CANONICAL_SOFTWARE_MAP_MODEL_IMPORT)})(["'])`,
    "g",
  );
  // `$` is special in String.replace replacements; a path containing `$1`
  // or `$&` would corrupt the emitted import. `$$` emits a literal `$`.
  const literalReplacement = replacement.replace(/\$/g, "$$$$");
  return source.replace(pattern, `$1${literalReplacement}$3`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The read ladder
// ---------------------------------------------------------------------------
// map-for-commit(C):
//   1. local note under refs/notes/dev-fast/*                (primary)
//   2. fetched peer note under refs/notes/dev-fast/remote/*  → backfill local
//   3. jj evolog recovery: newest predecessor commit of C's change that has a
//      note → copy forward to C                              (async path only)
//
// Both roles are strict note reads: there is no file fallback. The `role`
// parameter is kept for API stability but no longer changes behavior (the
// old tier 4 — live-map fallback for the head role — was deleted with the
// live map itself).

export interface SoftwareMapSourceReadResult {
  commit: string;
  source: string;
  tier: "note" | "remote-note" | "evolog";
}

export async function readSoftwareMapSourceForRef(input: {
  repoRootPath: string;
  ref: string;
  role: SoftwareMapArtifactRole;
}): Promise<SoftwareMapSourceReadResult | null> {
  const gitDir = await gitCommonDir(input.repoRootPath);
  if (!gitDir) return null;

  const resolved = await resolveRevision(input.repoRootPath, input.ref).catch(
    () => null,
  );
  if (!resolved?.commit) return null;

  const local = await readNote({
    rootPath: input.repoRootPath,
    ref: SOFTWARE_MAP_NOTES_REF,
    commit: resolved.commit,
  });
  if (local !== null) {
    return { commit: resolved.commit, source: local, tier: "note" };
  }

  const remote = await readNote({
    rootPath: input.repoRootPath,
    ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
    commit: resolved.commit,
  });
  if (remote !== null) {
    await backfillNote(input.repoRootPath, resolved.commit, remote);
    return { commit: resolved.commit, source: remote, tier: "remote-note" };
  }

  const recovered = await recoverNoteFromEvolog({
    repoRootPath: input.repoRootPath,
    commit: resolved.commit,
  });
  if (recovered !== null) {
    return { commit: resolved.commit, source: recovered, tier: "evolog" };
  }
  return null;
}

export function readSoftwareMapSourceForRefSync(input: {
  repoRootPath: string;
  ref: string;
  role: SoftwareMapArtifactRole;
}): SoftwareMapSourceReadResult | null {
  const gitDir = gitCommonDirSync(input.repoRootPath);
  if (!gitDir) return null;

  const resolved = resolveRevisionSync(input.repoRootPath, input.ref);
  if (!resolved?.commit) return null;

  const local = readNoteSync({
    rootPath: input.repoRootPath,
    ref: SOFTWARE_MAP_NOTES_REF,
    commit: resolved.commit,
  });
  if (local !== null) {
    return { commit: resolved.commit, source: local, tier: "note" };
  }
  const remote = readNoteSync({
    rootPath: input.repoRootPath,
    ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
    commit: resolved.commit,
  });
  if (remote !== null) {
    try {
      writeNoteSync({
        rootPath: input.repoRootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: resolved.commit,
        content: remote,
      });
    } catch {
      // Backfill is best-effort.
    }
    return { commit: resolved.commit, source: remote, tier: "remote-note" };
  }
  // Evolog recovery is async-only; the async scan is the perf path and the
  // sync path self-heals on the next async pass.
  return null;
}

async function backfillNote(
  repoRootPath: string,
  commit: string,
  content: string,
): Promise<void> {
  try {
    await writeNote({
      rootPath: repoRootPath,
      ref: SOFTWARE_MAP_NOTES_REF,
      commit,
      content,
    });
  } catch {
    // Backfill is best-effort; the source read already succeeded.
  }
}

/**
 * jj rewrites commits constantly (restacks, squashes, describes); notes are
 * keyed by commit hash and do not follow. Recover at read time: walk the
 * change's evolog for the newest predecessor that has a note (local or
 * fetched) and copy it forward to the current commit.
 */
async function recoverNoteFromEvolog(input: {
  repoRootPath: string;
  commit: string;
}): Promise<string | null> {
  const vcs = await detectLocalVcs(input.repoRootPath).catch(() => null);
  if (vcs?.kind !== "jj") return null;
  const predecessors = await evologCommitIds({
    rootPath: input.repoRootPath,
    ref: input.commit,
  });
  for (const predecessor of predecessors) {
    if (predecessor === input.commit) continue;
    const source = await readNoteFromEitherNamespace({
      repoRootPath: input.repoRootPath,
      commit: predecessor,
    });
    if (source !== null) {
      await backfillNote(input.repoRootPath, input.commit, source);
      process.stderr.write(
        `software map: recovered note for ${input.commit.slice(0, 12)} from predecessor ${predecessor.slice(0, 12)} (jj rewrite)\n`,
      );
      return source;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scratch buffers (the authoring surface)
// ---------------------------------------------------------------------------
// A scratch is a hydrated working copy of one commit's note at
// $GIT_COMMON_DIR/dev-fast/scratch/<commit>/. It is note-shaped (canonical
// import), derived (hydrated from the read ladder, or a schema stub when the
// ladder fully misses), and disposable (everything durable is in notes).

export function scratchSoftwareMapPath(input: {
  repoRootPath: string;
  commit: string;
}): string | null {
  const gitDir = gitCommonDirSync(input.repoRootPath);
  if (!gitDir) return null;
  return path.join(
    scratchSoftwareMapDir(gitDir, input.commit),
    SOFTWARE_MAP_FILE_NAME,
  );
}

export interface HydrateScratchResult {
  commit: string;
  /** The map scratch file. */
  path: string;
  hydratedFrom: "note" | "remote-note" | "evolog" | "ancestor-note" | "stub";
  /** The annotated ancestor that seeded the scratch (ancestor-note only). */
  seedCommit?: string;
  /** First-parent commits between the seed and the target (ancestor-note only). */
  distance?: number;
  /**
   * True when a scratch already existed with content that differs from what
   * hydration would write (unflushed edits). Hydration then leaves the
   * scratch alone unless `force` discards it.
   */
  dirty: boolean;
}

// Pathological histories are bounded: the ancestor walk gives up after this
// many first-parent commits.
const ANCESTOR_SEED_WALK_LIMIT = 10_000;

// Hydration ladder for a scratch:
//   a. the exact commit's note (local → fetched peer, backfilled → evolog);
//   b. the nearest annotated first-parent ANCESTOR's note (local or fetched
//      namespace) — the seed for stacked work: a base commit seeds from the
//      previous review's flushed head;
//   c. the schema stub when nothing anywhere has a note.
export async function hydrateScratch(input: {
  repoRootPath: string;
  rev: string;
  force?: boolean;
}): Promise<HydrateScratchResult> {
  const gitDir = await gitCommonDir(input.repoRootPath);
  if (!gitDir) {
    throw new Error(`No git repository found at ${input.repoRootPath}`);
  }
  const resolved = await resolveRevision(input.repoRootPath, input.rev).catch(
    () => null,
  );
  if (!resolved?.commit) {
    throw new Error(`Unable to resolve revision: ${input.rev}`);
  }
  const commit = resolved.commit;
  const scratchDir = scratchSoftwareMapDir(gitDir, commit);
  const mapPath = path.join(scratchDir, SOFTWARE_MAP_FILE_NAME);

  const mapRead = await readSoftwareMapSourceForRef({
    repoRootPath: input.repoRootPath,
    ref: commit,
    role: "head",
  });

  let mapSource = mapRead?.source ?? null;
  let hydratedFrom: HydrateScratchResult["hydratedFrom"] =
    mapRead?.tier ?? "stub";
  let seedCommit: string | undefined;
  let distance: number | undefined;
  if (mapSource === null) {
    const ancestor = await findNearestAnnotatedAncestor({
      repoRootPath: input.repoRootPath,
      commit,
    });
    if (ancestor) {
      mapSource = await readNoteFromEitherNamespace({
        repoRootPath: input.repoRootPath,
        commit: ancestor.commit,
      });
      if (mapSource !== null) {
        hydratedFrom = "ancestor-note";
        seedCommit = ancestor.commit;
        distance = ancestor.distance;
      }
    }
  }

  const existingMap = readFileOrNull(mapPath);
  // Dirty means "differs from what hydration WOULD write" — for the stub
  // tier that is the schema stub itself, not null (or an untouched stub
  // scratch would read as unflushed edits forever).
  const hydratedMapContent = mapSource ?? softwareMapStubSource();
  const dirty = existingMap !== null && existingMap !== hydratedMapContent;

  if (dirty && !input.force) {
    return {
      commit,
      path: mapPath,
      hydratedFrom,
      seedCommit,
      distance,
      dirty: true,
    };
  }

  mkdirSync(scratchDir, { recursive: true });
  // The scratch stays note-shaped: note content (canonical import) verbatim,
  // so an untouched scratch is byte-equal to its seed note and a flush
  // round-trips byte-exactly.
  writeFileIfChangedSync(mapPath, hydratedMapContent);
  writeScratchEditorSupportSync(scratchDir);

  return {
    commit,
    path: mapPath,
    hydratedFrom,
    seedCommit,
    distance,
    dirty: false,
  };
}

/**
 * Walk `git rev-list --first-parent <commit>` for the nearest ancestor that
 * has a map note in the local ref or the fetched remote/* namespace. One
 * `listNoteCommits` call per ref replaces per-ancestor probing.
 */
async function findNearestAnnotatedAncestor(input: {
  repoRootPath: string;
  commit: string;
}): Promise<{ commit: string; distance: number } | null> {
  const [local, remote] = await Promise.all([
    listNoteCommits({
      rootPath: input.repoRootPath,
      ref: SOFTWARE_MAP_NOTES_REF,
    }),
    listNoteCommits({
      rootPath: input.repoRootPath,
      ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
    }),
  ]);
  const annotated = new Set(
    [...local, ...remote].map((sha) => sha.toLowerCase()),
  );
  if (annotated.size === 0) return null;

  const listed = await git(
    input.repoRootPath,
    [
      "rev-list",
      "--first-parent",
      `--max-count=${ANCESTOR_SEED_WALK_LIMIT + 1}`,
      input.commit,
    ],
    { allowFailure: true },
  );
  if (!listed.ok) return null;
  const revs = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // revs[0] is the commit itself — already probed by the exact-commit tiers.
  for (let index = 1; index < revs.length; index += 1) {
    if (annotated.has(revs[index].toLowerCase())) {
      return { commit: revs[index], distance: index };
    }
  }
  return null;
}

async function readNoteFromEitherNamespace(input: {
  repoRootPath: string;
  commit: string;
}): Promise<string | null> {
  return (
    (await readNote({
      rootPath: input.repoRootPath,
      ref: SOFTWARE_MAP_NOTES_REF,
      commit: input.commit,
    })) ??
    (await readNote({
      rootPath: input.repoRootPath,
      ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
      commit: input.commit,
    }))
  );
}

/**
 * Flush a scratch to its commit's note: the strict-validation gate lives in
 * the CLI (`review map check`). Stored notes must be location-independent, so
 * the content is canonicalized (`canonicalizeModelImport`) before the write —
 * matching the module contract and the prune sweep's equality check. The
 * caller that just validated may thread the exact validated bytes via
 * `mapSource` so the note holds exactly what was validated (never a scratch
 * re-read that could have changed since); when omitted the scratch file is
 * read.
 */
export async function flushScratch(input: {
  repoRootPath: string;
  commit: string;
  mapSource?: string;
}): Promise<{ commit: string }> {
  const mapPath = scratchSoftwareMapPath({
    repoRootPath: input.repoRootPath,
    commit: input.commit,
  });
  if (!mapPath) {
    throw new Error(`No git repository found at ${input.repoRootPath}`);
  }
  const mapSource = input.mapSource ?? readFileOrNull(mapPath);
  if (mapSource === null) {
    throw new Error(
      `No scratch exists for ${input.commit}. Run review map open first.`,
    );
  }
  await writeNote({
    rootPath: input.repoRootPath,
    ref: SOFTWARE_MAP_NOTES_REF,
    commit: input.commit,
    content: canonicalizeModelImport(mapSource),
  });
  return { commit: input.commit };
}

function softwareMapStubSource(): string {
  return [
    `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
    "",
    "export default defineSoftwareMap({",
    "  people: {},",
    "  systems: {},",
    "  relationships: [],",
    "});",
    "",
  ].join("\n");
}

// Editor DX: the canonical specifier resolves nowhere from inside a git dir,
// so vendor ambient module declarations plus a scoped tsconfig beside every
// scratch.
function writeScratchEditorSupportSync(scratchDir: string): void {
  writeFileIfChangedSync(
    path.join(scratchDir, "software-map-model.d.ts"),
    vendoredModelTypes(),
  );
  writeFileIfChangedSync(
    path.join(scratchDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
        },
        include: [SOFTWARE_MAP_FILE_NAME, "software-map-model.d.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Materialization (derived cache for document-bundle static imports)
// ---------------------------------------------------------------------------

/** Copy note sources into the tolerant cache without importing authored code.
 * Server refresh uses this path; strict-validation warnings belong to CLI
 * materialization and publication, not to the serving process. */
export async function materializeSoftwareMapAtRefWithoutEvaluation(input: {
  repoRootPath: string;
  ref: string;
  role: SoftwareMapArtifactRole;
}): Promise<string | null> {
  const read = await readSoftwareMapSourceForRef(input);
  if (!read) return null;
  const gitDir = await gitCommonDir(input.repoRootPath);
  if (!gitDir) return null;
  return writeMaterializedArtifact({ gitDir, read }).outputPath;
}

export async function materializeSoftwareMapAtRef(input: {
  repoRootPath: string;
  ref: string;
  role: SoftwareMapArtifactRole;
}): Promise<string | null> {
  const read = await readSoftwareMapSourceForRef(input);
  if (!read) return null;
  const gitDir = await gitCommonDir(input.repoRootPath);
  if (!gitDir) return null;
  const written = writeMaterializedArtifact({ gitDir, read });
  // Gated by a content-hash marker, NOT by write status: the sync path may
  // have materialized this content first (making this write "unchanged"),
  // and the promised strict-validation warning must still fire once for it.
  await warnOnInvalidMaterializedSource({ gitDir, read });
  return written.outputPath;
}

export function materializeSoftwareMapAtRefSync(input: {
  repoRootPath: string;
  ref: string;
  role: SoftwareMapArtifactRole;
}): string | null {
  const read = readSoftwareMapSourceForRefSync(input);
  if (!read) return null;
  const gitDir = gitCommonDirSync(input.repoRootPath);
  if (!gitDir) return null;
  // Strict-validation warning is async-only (dynamic import); the async
  // materialization pass over the same commit covers it.
  return writeMaterializedArtifact({ gitDir, read }).outputPath;
}

function writeMaterializedArtifact(input: {
  gitDir: string;
  read: SoftwareMapSourceReadResult;
}) {
  const outputPath = path.join(
    materializedSoftwareMapDir(input.gitDir, input.read.commit),
    SOFTWARE_MAP_FILE_NAME,
  );
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const status = writeFileIfChangedSync(
    outputPath,
    localizeModelImport({
      source: canonicalizeModelImport(input.read.source),
      outputPath,
    }),
  );
  return { outputPath, status };
}

/**
 * The write gate (`review map check`) is strict, so a note that fails strict
 * validation means genuine schema drift (an old note against a newer schema).
 * The tolerant model still renders it — possibly as null — but the error must
 * not be silent: import the note against the STRICT model and warn on throw.
 */
async function warnOnInvalidMaterializedSource(input: {
  gitDir: string;
  read: SoftwareMapSourceReadResult;
}): Promise<void> {
  const strictPath = path.join(
    materializedSoftwareMapDir(input.gitDir, input.read.commit),
    `.strict-${SOFTWARE_MAP_FILE_NAME}`,
  );
  const markerPath = `${strictPath}.validated-hash`;
  const strictSource = localizeModelImport({
    source: canonicalizeModelImport(input.read.source),
    outputPath: strictPath,
    modelFile: STRICT_MODEL_FILE,
  });
  // Validate only when the content changed since the last validation attempt
  // (the marker records the hash whether validation passed or warned, so an
  // unchanged bad note doesn't re-warn every pass).
  const contentHash = createHash("sha256").update(strictSource).digest("hex");
  if (readFileOrNull(markerPath) === contentHash) return;
  try {
    writeFileIfChangedSync(strictPath, strictSource);
    const url = pathToFileURL(strictPath);
    url.searchParams.set("t", String(Date.now()));
    await import(url.href);
    writeFileIfChangedSync(markerPath, contentHash);
  } catch (error) {
    writeFileIfChangedSync(markerPath, contentHash);
    console.warn(
      `software map: note ${SOFTWARE_MAP_NOTES_REF} for commit ${input.read.commit} failed strict validation; the tolerant renderer may drop it. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared write helper
// ---------------------------------------------------------------------------

export function writeFileIfChangedSync(
  filePath: string,
  contents: string,
): "written" | "unchanged" {
  try {
    if (readFileSync(filePath, "utf8") === contents) return "unchanged";
  } catch {
    // Missing or unreadable files are rewritten below.
  }
  writeFileSync(filePath, contents, "utf8");
  return "written";
}

function vendoredModelTypes(): string {
  return `// Generated by \`review map open\`. Ambient declarations so the scratch
// software map typechecks in-editor; the runtime rewrites the import to the
// real model module during materialization.
declare module "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}" {
  export type SoftwareChangeStatus = "added" | "removed" | "modified" | "unchanged";
  export type SoftwareDataStoreKind =
    | "database"
    | "objectStore"
    | "bucket"
    | "artifactStore"
    | "fileStore";
  export interface SoftwareLineRange {
    fromLine: number;
    toLine: number;
  }
  export interface SoftwareSourceRange extends SoftwareLineRange {
    file: string;
  }
  export interface SoftwareCoverageFileInput {
    path: string;
    ranges?: SoftwareLineRange[];
  }
  export interface SoftwareCoverageInput {
    files?: Array<string | SoftwareCoverageFileInput>;
    globs?: string[];
  }
  export interface SoftwareRelationshipBaseInput {
    from: string;
    to: string;
    label?: string;
    description?: string;
  }
  export interface SoftwareCallRelationshipInput extends SoftwareRelationshipBaseInput {
    kind: "call";
    nthCallSite?: number;
  }
  export interface SoftwareSemanticRelationshipInput extends SoftwareRelationshipBaseInput {
    kind: "semantic";
    semanticKind?: string;
    sourceRanges?: SoftwareLineRange[];
  }
  export type SoftwareRelationshipInput =
    | SoftwareCallRelationshipInput
    | SoftwareSemanticRelationshipInput;
  export interface SoftwareElementBaseInput {
    id?: string;
    label?: string;
    description?: string;
    changeStatus?: SoftwareChangeStatus;
    coverage?: SoftwareCoverageInput;
    relationships?: SoftwareRelationshipInput[];
  }
  export interface PersonInput extends SoftwareElementBaseInput {}
  export interface SoftwareSystemInput extends SoftwareElementBaseInput {
    external?: boolean;
    containers?: SoftwareElementCollection<ContainerInput>;
    dataStores?: SoftwareElementCollection<DataStoreInput>;
  }
  export interface ContainerInput extends SoftwareElementBaseInput {
    components?: SoftwareElementCollection<ComponentInput>;
  }
  export interface SoftwareDataStoreFieldLeaf {
    type: string;
    example?: unknown;
    pk?: boolean;
    fk?: string | { table: string; field: string; label?: string };
    schema?: SoftwareDataStoreFieldSchema;
  }
  export type SoftwareDataStoreFieldSchema = {
    [field: string]: SoftwareDataStoreFieldLeaf | SoftwareDataStoreFieldSchema;
  };
  export interface SoftwareDataStoreCollectionInput {
    label?: string;
    key?: string;
    schema: SoftwareDataStoreFieldSchema;
  }
  export interface DataStoreInput extends SoftwareElementBaseInput {
    kind?: SoftwareDataStoreKind;
    tables?: Record<string, SoftwareDataStoreCollectionInput>;
    documents?: Record<string, SoftwareDataStoreCollectionInput>;
    components?: SoftwareElementCollection<ComponentInput>;
  }
  export interface ComponentInput extends SoftwareElementBaseInput {
    codeElements?: SoftwareElementCollection<CodeElementInput>;
  }
  export interface CodeElementInput extends SoftwareElementBaseInput {
    sourceRanges?: SoftwareSourceRange[];
  }
  export type SoftwareElementCollection<T extends SoftwareElementBaseInput> =
    | Record<string, T>
    | T[];
  export interface SoftwareModelInput {
    people?: SoftwareElementCollection<PersonInput>;
    systems?: SoftwareElementCollection<SoftwareSystemInput>;
    relationships?: SoftwareRelationshipInput[];
  }
  export interface NormalizedSoftwareModel {
    elements: unknown[];
    elementsByPath: ReadonlyMap<string, unknown>;
    relationships: unknown[];
  }
  export function defineSoftwareMap(
    input: SoftwareModelInput,
  ): NormalizedSoftwareModel;
}
`;
}
