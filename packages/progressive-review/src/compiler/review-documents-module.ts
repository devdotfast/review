import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  currentHead as currentHeadAsync,
  currentHeadSync,
  gitCommonDirSync,
  resolveRevision as resolveRevisionAsync,
} from "@dev.fast/local-vcs";

import {
  isInsideDirectory,
  normalizeViteModuleFilePath,
  reviewDocumentRoutePathForFile,
  toViteFsImport,
} from "../review-paths";
import {
  readReviewStoreRecord,
  resolveReviewRepoRootFromStore,
} from "../review-worktree-target";
import {
  materializeSoftwareMapAtRef,
  materializeSoftwareMapAtRefSync,
} from "../software-map-artifact";
import { span, spanSync } from "../startup-trace";

export const ACTIVE_REVIEW_DOCUMENT_MODULE_ID =
  "virtual:progressive-review-active-document";
export const RESOLVED_ACTIVE_REVIEW_DOCUMENT_MODULE_ID = `\0${ACTIVE_REVIEW_DOCUMENT_MODULE_ID}`;
export const REVIEW_AUTHORING_MODULE_ID =
  "virtual:progressive-review-authoring";
export const RESOLVED_REVIEW_AUTHORING_MODULE_ID = `\0${REVIEW_AUTHORING_MODULE_ID}`;

interface ReviewDocumentModuleManifest {
  slug: string;
  routePath: string;
  filePath: string;
  title: string;
  resolvedBaseRef: string | null;
  modelNames: string[];
  headSoftwareMapPath: string | null;
  baseSoftwareMapPath: string | null;
  isDefault: boolean;
}

interface ReviewDocumentScanFingerprintEntry {
  filePath: string;
  mtimeMs: number | null;
  size: number | null;
}

interface ReviewDocumentScanFingerprint {
  reviewStore: ReviewDocumentScanFingerprintEntry;
  reviewDocument: ReviewDocumentScanFingerprintEntry;
  reviewDocuments: ReviewDocumentScanFingerprintEntry[];
}

interface ReviewDocumentScanAsyncResult {
  manifests: ReviewDocumentModuleManifest[];
  softwareMapPaths: string[];
  sourceRoots: string[];
}

interface ReviewDocumentScanInput {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}

type ReviewDocumentInputWithMeta = {
  slug: string;
  routePath: string;
  filePath: string;
  titleFallback: string;
};

function normalizeReviewDocumentRoutePath(routePath: string): string {
  if (!routePath) return "/";
  const pathnameOnly = routePath.split(/[?#]/, 1)[0] || "/";
  const trimmed = pathnameOnly.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "/";
  return trimmed.endsWith(".mdx") ? trimmed.slice(0, -".mdx".length) : trimmed;
}

export async function generateActiveReviewDocumentModule(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
  activeRoutePath: string;
}): Promise<string> {
  const scan = await collectReviewDocumentScanForRuntime(input);
  const activeRoutePath = normalizeReviewDocumentRoutePath(
    input.activeRoutePath,
  );
  const document = scan.manifests.find(
    (manifest) =>
      normalizeReviewDocumentRoutePath(manifest.routePath) === activeRoutePath,
  );
  if (!document) {
    throw new Error(`No Review document exists for route ${activeRoutePath}.`);
  }
  return activeReviewDocumentModuleSource(document);
}

export async function generateReviewAuthoringModule(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
  activeRoutePath: string;
}): Promise<string> {
  const scan = await collectReviewDocumentScanForRuntime(input);
  const activeRoutePath = normalizeReviewDocumentRoutePath(
    input.activeRoutePath,
  );
  const document = scan.manifests.find(
    (manifest) =>
      normalizeReviewDocumentRoutePath(manifest.routePath) === activeRoutePath,
  );
  if (!document) {
    throw new Error(`No Review document exists for route ${activeRoutePath}.`);
  }
  return reviewAuthoringModuleSource(document);
}

function activeReviewDocumentModuleSource(
  document: ReviewDocumentModuleManifest,
): string {
  const documentImport = JSON.stringify(toViteFsImport(document.filePath));
  const lines = [
    `import * as reviewDocumentModule from ${documentImport};`,
    `import { createActiveReviewDocument } from "/src/review-documents-runtime";`,
    `import { __reviewDefinitionsReady } from "${REVIEW_AUTHORING_MODULE_ID}";`,
    ``,
    `await __reviewDefinitionsReady();`,
    ``,
    `export const activeReviewDocument = createActiveReviewDocument({`,
    ...reviewDocumentDescriptorMetadataSource(document, "  "),
    `  models: reviewDocumentModule,`,
    `  Component: reviewDocumentModule.default,`,
    `});`,
    ``,
  ];
  return lines.join("\n");
}

function reviewAuthoringModuleSource(
  document: ReviewDocumentModuleManifest,
): string {
  return [
    `import { createBrowserReviewDefinitionSession } from "/src/review-definition-runtime";`,
    `export { calls } from "/src/review-definition-runtime";`,
    `export { defineSoftwareModel } from "/src/software-map/model";`,
    ``,
    `const session = createBrowserReviewDefinitionSession({`,
    `  routePath: ${JSON.stringify(document.routePath)},`,
    `  softwareMap: null,`,
    `  baseSoftwareMap: null,`,
    `  requestOrigin: import.meta.env.SSR ? import.meta.env.DEV_FAST_REVIEW_SSR_ORIGIN : undefined,`,
    `});`,
    `session.begin();`,
    ``,
    `export const defineActors = session.defineActors;`,
    `export const defineAnchors = session.defineAnchors;`,
    `export const defineStores = session.defineStores;`,
    `export const defineSoftwareActors = session.defineSoftwareActors;`,
    `export const defineSoftwareStores = session.defineSoftwareStores;`,
    `export const __reviewDefinitionsReady = session.ready;`,
    `export const __reviewDefinitionDiagnostics = session.diagnostics;`,
    ``,
  ].join("\n");
}

export function collectReviewDocumentSoftwareMapPaths(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): Set<string> {
  return new Set(collectReviewDocumentScan(input).softwareMapPaths);
}

export function collectReviewDocumentSourceRoots(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): Set<string> {
  return new Set(collectReviewDocumentScan(input).sourceRoots);
}

export function collectReviewDocumentScanForRuntime(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): Promise<ReviewDocumentScanAsyncResult> {
  return span("collectReviewDocumentScanForRuntime", () =>
    collectReviewDocumentScanForRuntimeInner(input),
  );
}

async function collectReviewDocumentScanForRuntimeInner(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): Promise<ReviewDocumentScanAsyncResult> {
  const normalized = normalizeReviewDocumentScanInput(input);
  const fingerprint = collectReviewDocumentScanFingerprint(normalized);
  const discoveredDocuments = collectReviewDocumentDirectoryDocuments(
    normalized.reviewDocumentsDir,
    fingerprint,
  );
  const activeFilePath = path.resolve(input.reviewPath);
  const activeInput: ReviewDocumentInputWithMeta = {
    slug: "",
    routePath:
      reviewDocumentRoutePathForFile({
        reviewDocumentsDir: normalized.reviewDocumentsDir,
        filePath: activeFilePath,
      }) ?? "/",
    filePath: activeFilePath,
    titleFallback: "review",
  };
  const documents = [
    ...discoveredDocuments,
    ...(discoveredDocuments
      .map((document) => path.resolve(document.filePath))
      .includes(activeFilePath)
      ? []
      : [activeInput]),
  ];
  const allDocuments = documents
    .filter((document, index, array) => {
      const filePath = path.resolve(document.filePath);
      const duplicate = array
        .slice(0, index)
        .some((candidate) => path.resolve(candidate.filePath) === filePath);
      return !duplicate;
    })
    .sort((left, right) => (left.routePath > right.routePath ? 1 : -1));

  const manifests = await Promise.all(
    allDocuments.map((document) =>
      ensureReviewDocumentManifest(document, normalized),
    ),
  );
  const softwareMapPaths = new Set<string>();
  const sourceRoots = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.headSoftwareMapPath)
      softwareMapPaths.add(manifest.headSoftwareMapPath);
    if (manifest.baseSoftwareMapPath)
      softwareMapPaths.add(manifest.baseSoftwareMapPath);
    const sourceRoot = resolveReviewSoftwareMapRepoRootSafe({
      reviewRootPath: normalized.reviewRootPath,
    });
    if (sourceRoot) sourceRoots.add(sourceRoot);
  }
  for (const sourceRoot of sourceRoots) {
    for (const watchPath of softwareMapWatchPathsForRepo(sourceRoot)) {
      softwareMapPaths.add(watchPath);
    }
  }
  return {
    manifests,
    softwareMapPaths: [...softwareMapPaths],
    sourceRoots: [...sourceRoots],
  };
}

async function ensureReviewDocumentManifest(
  document: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
): Promise<ReviewDocumentModuleManifest> {
  const filePath = path.resolve(document.filePath);
  const metadata = reviewDocumentSourceMetadata(
    document.filePath,
    document.titleFallback,
  );
  const fallback = reviewDocumentModuleManifestFromMetadata(document, metadata);
  const review = readReviewStoreRecord(input.reviewRootPath);
  const storeRefs: [string, string] | null = review.sourceCommit
    ? [review.sourceCommit, review.baseCommit]
    : null;
  const isPinnedRefs = Boolean(storeRefs);
  const repoRoot = resolveReviewSoftwareMapRepoRootSafe(input);
  if (!repoRoot) {
    return fallback;
  }
  const [resolvedHeadRef, resolvedBaseRef] =
    storeRefs ??
    (await resolveReviewDocumentRefs(repoRoot, input.reviewRootPath).catch(
      (): [string | null, string | null] => [null, null],
    ));

  if (!isPinnedRefs && !resolvedHeadRef && !resolvedBaseRef) {
    return fallback;
  }

  const headRefForScan = isPinnedRefs
    ? (resolvedHeadRef ?? storeRefs?.[0] ?? null)
    : (resolvedHeadRef ?? null);
  const baseRefForScan = isPinnedRefs
    ? (resolvedBaseRef ?? storeRefs?.[1] ?? null)
    : (resolvedBaseRef ?? null);

  const manifest = await reviewDocumentSoftwareMapPathsAsyncInner({
    repoRoot,
    headRef: headRefForScan,
    baseRef: baseRefForScan,
  });
  const result: ReviewDocumentModuleManifest = {
    ...manifest,
    routePath: document.routePath,
    slug: document.slug,
    filePath,
    title: metadata.title,
    resolvedBaseRef: baseRefForScan,
    modelNames: metadata.modelNames,
    isDefault: document.slug === "",
  };

  return result;
}

async function resolveReviewDocumentRefs(
  repoRootPath: string,
  reviewRootPath: string,
): Promise<[string | null, string | null]> {
  return span("resolveReviewDocumentRefs", async () => {
    const review = readReviewStoreRecord(reviewRootPath);
    const headRef = review.sourceCommit
      ? ((
          await resolveRevisionAsync(repoRootPath, review.sourceCommit).catch(
            () => null,
          )
        )?.commit ?? review.sourceCommit)
      : ((await currentHeadAsync(repoRootPath).catch(() => null))?.commit ??
        null);
    const baseRef =
      (
        await resolveRevisionAsync(repoRootPath, review.baseCommit).catch(
          () => null,
        )
      )?.commit ?? review.baseCommit;
    return [headRef, baseRef];
  });
}

function reviewDocumentModuleManifestFromMetadata(
  document: ReviewDocumentInputWithMeta,
  metadata: {
    title: string;
    modelNames: string[];
  },
): ReviewDocumentModuleManifest {
  return {
    slug: document.slug,
    routePath: document.routePath,
    filePath: path.resolve(document.filePath),
    title: metadata.title,
    resolvedBaseRef: null,
    modelNames: metadata.modelNames,
    headSoftwareMapPath: null,
    baseSoftwareMapPath: null,
    isDefault: document.slug === "",
  };
}

function resolveReviewSoftwareMapRepoRootSafe(input: {
  reviewRootPath: string;
}): string {
  return resolveReviewRepoRootFromStore(input.reviewRootPath);
}

async function reviewDocumentSoftwareMapPathsAsyncInner(input: {
  repoRoot: string;
  headRef: string | null;
  baseRef: string | null;
}): Promise<{
  headSoftwareMapPath: string | null;
  baseSoftwareMapPath: string | null;
}> {
  return span("reviewDocumentSoftwareMapPathsAsyncInner", async () => {
    const repoRootPath = input.repoRoot;
    // Both roles are strict note reads: an unpinned head resolves to the
    // working copy's commit (the caller passed it as headRef) and reads that
    // commit's note like any pinned ref. There is no live-map fallback.
    const [materializedHeadSoftwareMapPath, baseSoftwareMapPath] =
      await Promise.all([
        input.headRef
          ? materializeSoftwareMapAtRef({
              repoRootPath,
              ref: input.headRef,
              role: "head",
            })
          : Promise.resolve(null),
        input.baseRef
          ? materializeSoftwareMapAtRef({
              repoRootPath,
              ref: input.baseRef,
              role: "base",
            })
          : Promise.resolve(null),
      ]);

    return {
      headSoftwareMapPath: materializedHeadSoftwareMapPath,
      baseSoftwareMapPath: baseSoftwareMapPath ?? null,
    };
  });
}

export function isReviewDocumentModule(
  id: string,
  input: { reviewPath: string; reviewDocumentsDir: string },
): boolean {
  const modulePath = normalizeViteModuleFilePath(id);
  if (modulePath === normalizeViteModuleFilePath(input.reviewPath)) return true;
  if (path.extname(modulePath) !== ".mdx") return false;
  return isInsideDirectory(
    modulePath,
    normalizeViteModuleFilePath(input.reviewDocumentsDir),
  );
}

function collectReviewDocumentScan(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): {
  manifests: ReviewDocumentModuleManifest[];
  softwareMapPaths: string[];
  sourceRoots: string[];
} {
  const normalized = normalizeReviewDocumentScanInput(input);
  const fingerprint = collectReviewDocumentScanFingerprint(normalized);
  return spanSync("collectReviewDocumentScan", () =>
    collectReviewDocumentScanInner(normalized, fingerprint),
  );
}

function collectReviewDocumentScanInner(
  input: ReviewDocumentScanInput,
  fingerprint: ReviewDocumentScanFingerprint,
): {
  manifests: ReviewDocumentModuleManifest[];
  softwareMapPaths: string[];
  sourceRoots: string[];
} {
  const reviewPath = path.resolve(input.reviewPath);
  const documents = [
    {
      slug: "",
      routePath: "/",
      filePath: reviewPath,
      titleFallback: "review",
    },
    ...collectReviewDocumentDirectoryDocuments(
      input.reviewDocumentsDir,
      fingerprint,
    ),
  ];

  const sourceRoots = new Set<string>();
  const softwareMapPaths = new Set<string>();
  const manifests = documents.map((document) => {
    const { title, modelNames } = reviewDocumentSourceMetadata(
      document.filePath,
      document.titleFallback,
    );
    const softwareMapPathsResult = spanSync(
      `mapPaths ${path.basename(document.filePath)}`,
      () =>
        reviewDocumentSoftwareMapPaths({
          reviewRootPath: input.reviewRootPath,
        }),
      document.filePath,
    );
    if (softwareMapPathsResult.headSoftwareMapPath) {
      softwareMapPaths.add(
        path.resolve(softwareMapPathsResult.headSoftwareMapPath),
      );
    }
    if (softwareMapPathsResult.baseSoftwareMapPath) {
      softwareMapPaths.add(
        path.resolve(softwareMapPathsResult.baseSoftwareMapPath),
      );
    }

    sourceRoots.add(resolveReviewRepoRootFromStore(input.reviewRootPath));

    return {
      ...document,
      filePath: path.resolve(document.filePath),
      title,
      resolvedBaseRef: null,
      modelNames,
      isDefault: document.slug === "",
      ...softwareMapPathsResult,
    };
  });
  for (const sourceRoot of sourceRoots) {
    for (const watchPath of softwareMapWatchPathsForRepo(sourceRoot)) {
      softwareMapPaths.add(watchPath);
    }
  }
  return {
    manifests,
    softwareMapPaths: [...softwareMapPaths],
    sourceRoots: [...sourceRoots],
  };
}

function collectReviewDocumentDirectoryDocuments(
  reviewDocumentsDir: string,
  fingerprint: ReviewDocumentScanFingerprint,
): Array<ReviewDocumentInputWithMeta> {
  return fingerprint.reviewDocuments
    .map((entry) => {
      const routePath = reviewDocumentRoutePathForFile({
        reviewDocumentsDir,
        filePath: entry.filePath,
      });
      if (!routePath) return null;
      const slug = path.basename(entry.filePath, ".mdx");
      return {
        slug,
        routePath,
        filePath: entry.filePath,
        titleFallback: slug,
      };
    })
    .filter(
      (document): document is ReviewDocumentInputWithMeta => document !== null,
    )
    .sort((left, right) => left.routePath.localeCompare(right.routePath));
}

function collectReviewDocumentScanFingerprint(
  input: ReviewDocumentScanInput,
): ReviewDocumentScanFingerprint {
  const reviewDocument = reviewDocumentFileFingerprint(input.reviewPath);
  const reviewDocumentDirEntries = collectReviewDocumentMdxEntries(
    input.reviewDocumentsDir,
  );
  const reviewDocuments = reviewDocumentDirEntries
    .map((filePath) => {
      const source = reviewDocumentFileFingerprint(filePath);
      return { ...source, filePath: path.resolve(filePath) };
    })
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  return {
    reviewStore: reviewDocumentFileFingerprint(
      path.join(input.reviewRootPath, "review.json"),
    ),
    reviewDocument,
    reviewDocuments,
  };
}

function collectReviewDocumentMdxEntries(reviewDocumentsDir: string): string[] {
  if (!existsSync(reviewDocumentsDir)) return [];
  return readdirSync(reviewDocumentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => path.resolve(reviewDocumentsDir, entry.name));
}

function normalizeReviewDocumentScanInput(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): ReviewDocumentScanInput {
  return {
    reviewPath: path.resolve(input.reviewPath),
    reviewDocumentsDir: path.resolve(input.reviewDocumentsDir),
    reviewRootPath: path.resolve(input.reviewRootPath),
  };
}

function reviewDocumentFileFingerprint(
  filePath: string,
): ReviewDocumentScanFingerprintEntry {
  let stats: import("node:fs").Stats | null = null;
  try {
    stats = statSync(filePath);
  } catch {
    return {
      filePath: path.resolve(filePath),
      mtimeMs: null,
      size: null,
    };
  }
  return {
    filePath: path.resolve(filePath),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function reviewDocumentDescriptorMetadataSource(
  document: ReviewDocumentModuleManifest,
  indent: string,
): string[] {
  return [
    `${indent}slug: ${JSON.stringify(document.slug)},`,
    `${indent}routePath: ${JSON.stringify(document.routePath)},`,
    `${indent}filePath: ${JSON.stringify(document.filePath)},`,
    `${indent}title: ${JSON.stringify(document.title)},`,
    `${indent}modelNames: ${JSON.stringify(document.modelNames)},`,
    `${indent}isDefault: ${String(document.isDefault)},`,
  ];
}

function reviewDocumentSoftwareMapPaths(input: { reviewRootPath: string }): {
  headSoftwareMapPath: string | null;
  baseSoftwareMapPath: string | null;
} {
  const repoRootPath = resolveReviewRepoRootFromStore(input.reviewRootPath);
  const review = readReviewStoreRecord(input.reviewRootPath);
  const headRef =
    review.sourceCommit ??
    spanSync("currentHeadSync (git)", () =>
      resolveDefaultReviewHeadRefSync(repoRootPath),
    );
  const baseRef = review.baseCommit;
  // Strict note reads for both roles: an unpinned head is the working copy's
  // current commit, materialized like any pinned ref (no live-map fallback).
  const materializedHeadSoftwareMapPath = headRef
    ? spanSync(
        "materializeSoftwareMapAtRefSync head",
        () =>
          materializeSoftwareMapAtRefSync({
            repoRootPath,
            ref: headRef,
            role: "head",
          }),
        headRef,
      )
    : null;
  const baseSoftwareMapPath = baseRef
    ? spanSync(
        "materializeSoftwareMapAtRefSync base",
        () =>
          materializeSoftwareMapAtRefSync({
            repoRootPath,
            ref: baseRef,
            role: "base",
          }),
        baseRef,
      )
    : null;

  return {
    headSoftwareMapPath: materializedHeadSoftwareMapPath,
    baseSoftwareMapPath,
  };
}

// Paths the dev server should watch for map changes: notes are the only
// durable map state, so watch the notes refs themselves and packed-refs.
export function softwareMapWatchPathsForRepo(repoRootPath: string): string[] {
  const gitDir = gitCommonDirSync(repoRootPath);
  if (!gitDir) return [];
  return [
    path.join(gitDir, "refs", "notes", "dev-fast"),
    path.join(gitDir, "packed-refs"),
  ];
}

const NOTES_REFS_SUFFIX = path.join("refs", "notes", "dev-fast");

export function gitDirForSoftwareMapWatchPath(
  watchPath: string,
): string | null {
  const resolved = path.resolve(watchPath);
  if (resolved.endsWith(`${path.sep}${NOTES_REFS_SUFFIX}`)) {
    return resolved.slice(0, -(NOTES_REFS_SUFFIX.length + path.sep.length));
  }
  if (path.basename(resolved) === "packed-refs") {
    return path.dirname(resolved);
  }
  return null;
}

export function softwareMapNotesRefFingerprint(
  gitDirs: Iterable<string>,
): string {
  const parts: string[] = [];
  for (const gitDir of [...new Set(gitDirs)].sort()) {
    let refs: string;
    try {
      refs = execFileSync(
        "git",
        [
          "--git-dir",
          gitDir,
          "for-each-ref",
          "refs/notes/dev-fast",
          "--format=%(refname) %(objectname)",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      refs = "unavailable";
    }
    parts.push(`${gitDir}\n${refs}`);
  }
  return parts.join("\0");
}

function resolveDefaultReviewHeadRefSync(repoRootPath: string): string | null {
  return currentHeadSync(repoRootPath)?.commit ?? null;
}

function reviewDocumentSoftwareModelNamesFromSource(source: string): string[] {
  const names: string[] = [];
  const re =
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*defineSoftwareModel\s*\(/g;
  let m;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

function reviewDocumentTitleFromSource(
  source: string,
  fallback: string,
): string {
  return firstMarkdownHeading(source) ?? fallback;
}

function reviewDocumentSourceMetadata(
  filePath: string,
  fallback: string,
): {
  title: string;
  modelNames: string[];
} {
  try {
    const source = readFileSync(filePath, "utf8");
    return {
      title: reviewDocumentTitleFromSource(source, fallback),
      modelNames: reviewDocumentSoftwareModelNamesFromSource(source),
    };
  } catch {
    return {
      title: fallback,
      modelNames: [],
    };
  }
}

export function reviewDocumentTitle(
  filePath: string,
  fallback: string,
): string {
  try {
    return reviewDocumentTitleFromSource(
      readFileSync(filePath, "utf8"),
      fallback,
    );
  } catch {
    return fallback;
  }
}

function firstMarkdownHeading(source: string): string | null {
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const title = match[1].replace(/\s+#+\s*$/, "").trim();
    return title.length > 0 ? title : null;
  }
  return null;
}
