import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  currentHead as currentHeadAsync,
  currentHeadSync,
  gitCommonDirSync,
  resolveRevision as resolveRevisionAsync,
} from "@dev.fast/local-vcs";

import { createAsyncLimiter as createReviewDocumentAsyncLimiter } from "../async-limiter";
import { writeFileAtomic } from "../atomic-write";
import {
  isInsideDirectory,
  normalizeViteModuleFilePath,
  reviewDocumentRoutePathForFile,
  toViteFsImport,
} from "../review-paths";
import { reviewRepoStorageRoot, safeStorageSegment } from "../review-storage";
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

interface ReviewDocumentScanCache {
  fingerprint: ReviewDocumentScanFingerprint;
  manifests: ReviewDocumentModuleManifest[];
  softwareMapPaths: string[];
  sourceRoots: string[];
}

interface ReviewDocumentScanCacheEntry {
  version: 1;
  documentPath: string;
  fileFingerprint: ReviewDocumentScanFingerprintEntry;
  resolvedHeadRef: string | null;
  resolvedBaseRef: string | null;
  manifest: {
    slug: string;
    routePath: string;
    filePath: string;
    title: string;
    resolvedBaseRef?: string | null;
    modelNames: string[];
    headSoftwareMapPath: string | null;
    baseSoftwareMapPath: string | null;
    isDefault: boolean;
  };
  updatedAtMs: number;
}

interface ReviewDocumentScanState {
  fingerprint: ReviewDocumentScanFingerprint;
  documents: Array<ReviewDocumentInputWithMeta>;
  cachedManifests: Map<string, ReviewDocumentModuleManifest>;
  inFlightScans: Map<
    string,
    Promise<ReviewDocumentModuleManifest | ReviewDocumentModuleManifestFailure>
  >;
}

interface ReviewDocumentScanCancellation {
  isCanceled: boolean;
}

interface ReviewDocumentScanAsyncResult {
  manifests: ReviewDocumentModuleManifest[];
  softwareMapPaths: string[];
  sourceRoots: string[];
  activeEntry: ReviewDocumentModuleManifest | null;
  activeRoutePath: string;
  ensureReviewDocumentFresh: (routePath: string) => Promise<{
    softwareMapPaths: string[];
    shouldInvalidateModule: boolean;
  }>;
  cancel: () => void;
}

interface ReviewDocumentScanInput {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}

const reviewDocumentScanCache = new Map<string, ReviewDocumentScanCache>();
const reviewDocumentAsyncScanState = new Map<string, ReviewDocumentScanState>();
const reviewDocumentScanCacheDirSuffix = "review-document-cache";
const reviewDocumentScanCacheConcurrency = Math.max(
  1,
  Math.floor(
    Number.parseInt(
      process.env.DEV_FAST_REVIEW_DOCUMENT_SCAN_CONCURRENCY?.trim() ?? "4",
      10,
    ) || 4,
  ),
);
const reviewDocumentScanLimiter = createReviewDocumentAsyncLimiter(
  reviewDocumentScanCacheConcurrency,
);

function reviewDocumentScanCachePath(
  reviewRootPath: string,
  documentPath: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(path.resolve(documentPath))
    .digest("hex");
  return path.join(
    reviewRepoStorageRoot(reviewRootPath),
    reviewDocumentScanCacheDirSuffix,
    `${safeStorageSegment(digest)}.json`,
  );
}

interface ReviewDocumentModuleManifestFailure {
  status: "skipped";
  filePath: string;
}

type ReviewDocumentInputWithMeta = {
  slug: string;
  routePath: string;
  filePath: string;
  titleFallback: string;
};

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
  const scanState: ReviewDocumentScanCancellation = { isCanceled: false };
  const key = reviewDocumentScanCacheKey(normalized);
  const fingerprint = collectReviewDocumentScanFingerprint(normalized);
  const state = collectReviewDocumentScanStateForInput(
    key,
    normalized,
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
    ...state.documents,
    ...(state.documents
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

  const activeInputEntry = allDocuments.find(
    (document) => path.resolve(document.filePath) === activeFilePath,
  );
  if (!activeInputEntry) {
    throw new Error(`Review document not found: ${activeFilePath}`);
  }

  await Promise.all(
    allDocuments
      .filter((document) => path.resolve(document.filePath) !== activeFilePath)
      .map((document) =>
        seedReviewDocumentManifestFromCache(document, normalized, state),
      ),
  );

  const activeEntryPromise = getReviewDocumentManifestForDocument(
    activeInputEntry,
    normalized,
    state,
    scanState,
  );

  const activeEntryResult = await activeEntryPromise.catch(() => null);
  const activeManifest = isReviewDocumentManifest(activeEntryResult)
    ? activeEntryResult
    : reviewDocumentModuleManifestFromMetadata(
        activeInputEntry,
        reviewDocumentSourceMetadata(
          activeInputEntry.filePath,
          activeInputEntry.titleFallback,
        ),
      );

  const manifests = collectReviewDocumentScanManifestsFromState(
    allDocuments,
    activeManifest,
    state,
    normalized,
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
    activeEntry: activeManifest,
    activeRoutePath: activeInputEntry.routePath,
    ensureReviewDocumentFresh: (routePath) =>
      ensureReviewDocumentFreshForRoute(
        routePath,
        activeInputEntry,
        normalized,
        state,
        scanState,
      ),
    cancel: () => {
      scanState.isCanceled = true;
    },
  };
}

async function seedReviewDocumentManifestFromCache(
  document: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
  state: ReviewDocumentScanState,
): Promise<void> {
  const filePath = path.resolve(document.filePath);
  const cache = await readReviewDocumentScanCacheFromDisk({
    reviewRootPath: input.reviewRootPath,
    filePath,
    fileFingerprint: reviewDocumentFileFingerprint(filePath),
  });

  if (cache && path.resolve(cache.manifest.filePath) === filePath) {
    state.cachedManifests.set(filePath, {
      ...cache.manifest,
      resolvedBaseRef:
        cache.manifest.resolvedBaseRef ?? cache.resolvedBaseRef ?? null,
      isDefault: document.slug === "",
      filePath,
    });
    return;
  }

  state.cachedManifests.delete(filePath);
}

function ensureReviewDocumentFreshForRoute(
  routePath: string,
  _activeInput: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
  state: ReviewDocumentScanState,
  scanState: ReviewDocumentScanCancellation,
): Promise<{
  softwareMapPaths: string[];
  shouldInvalidateModule: boolean;
}> {
  const normalizedRoutePath = normalizeReviewDocumentRoutePath(routePath);
  const document = state.documents.find(
    (candidate) => candidate.routePath === normalizedRoutePath,
  );
  if (!document) {
    return Promise.resolve({
      softwareMapPaths: [],
      shouldInvalidateModule: false,
    });
  }

  const filePath = path.resolve(document.filePath);
  const previousManifest = state.cachedManifests.get(filePath) ?? null;
  const previousManifestMissingPaths = previousManifest
    ? reviewDocumentManifestHasMissingArtifactPaths(previousManifest)
    : false;

  return getReviewDocumentManifestForDocument(
    document,
    input,
    state,
    scanState,
  ).then((nextManifest) => {
    if (!isReviewDocumentManifest(nextManifest)) {
      return { softwareMapPaths: [], shouldInvalidateModule: false };
    }
    const manifest = { ...nextManifest, filePath };
    const shouldInvalidateModule =
      !reviewDocumentModuleManifestEquals(previousManifest, manifest) ||
      previousManifestMissingPaths;
    return {
      softwareMapPaths: reviewDocumentManifestSoftwareMapPaths(manifest),
      shouldInvalidateModule,
    };
  });
}

function normalizeReviewDocumentRoutePath(routePath: string): string {
  if (!routePath) return "/";
  const pathnameOnly = routePath.split(/[?#]/, 1)[0] || "/";
  const trimmed = pathnameOnly.replace(/\/+$/, "") || "/";
  if (trimmed === "/") return "/";
  return trimmed.endsWith(".mdx") ? trimmed.slice(0, -".mdx".length) : trimmed;
}

function reviewDocumentManifestSoftwareMapPaths(
  manifest: ReviewDocumentModuleManifest,
): string[] {
  const softwareMapPaths = new Set<string>();
  if (manifest.headSoftwareMapPath) {
    softwareMapPaths.add(manifest.headSoftwareMapPath);
  }
  if (manifest.baseSoftwareMapPath) {
    softwareMapPaths.add(manifest.baseSoftwareMapPath);
  }
  return [...softwareMapPaths];
}

function reviewDocumentManifestHasMissingArtifactPaths(
  manifest: ReviewDocumentModuleManifest,
): boolean {
  return reviewDocumentManifestSoftwareMapPaths(manifest).some(
    (mapPath) => !existsSync(mapPath),
  );
}

function reviewDocumentModuleManifestEquals(
  left: ReviewDocumentModuleManifest | null,
  right: ReviewDocumentModuleManifest,
): boolean {
  if (!left) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectReviewDocumentScanStateForInput(
  key: string,
  input: ReviewDocumentScanInput,
  fingerprint: ReviewDocumentScanFingerprint,
): ReviewDocumentScanState {
  const cached = reviewDocumentAsyncScanState.get(key);
  if (
    cached &&
    reviewDocumentScanFingerprintsMatch(cached.fingerprint, fingerprint)
  ) {
    return cached;
  }

  const documents = collectReviewDocumentDirectoryDocuments(
    input.reviewDocumentsDir,
    fingerprint,
  );
  const state: ReviewDocumentScanState = {
    fingerprint,
    documents,
    cachedManifests: new Map(),
    inFlightScans: new Map(),
  };
  reviewDocumentAsyncScanState.set(key, state);
  return state;
}

function collectReviewDocumentScanManifestsFromState(
  documents: ReadonlyArray<ReviewDocumentInputWithMeta>,
  activeManifest: ReviewDocumentModuleManifest | null,
  state: ReviewDocumentScanState,
  _input: ReviewDocumentScanInput,
): ReviewDocumentModuleManifest[] {
  return documents.map((document) => {
    const filePath = path.resolve(document.filePath);
    if (activeManifest && activeManifest.filePath === filePath)
      return activeManifest;
    const cached = state.cachedManifests.get(filePath);
    if (cached) return cached;
    const metadata = reviewDocumentSourceMetadata(
      document.filePath,
      document.titleFallback,
    );
    return reviewDocumentModuleManifestFromMetadata(document, metadata);
  });
}

function isReviewDocumentManifest(
  value:
    | ReviewDocumentModuleManifest
    | ReviewDocumentModuleManifestFailure
    | null,
): value is ReviewDocumentModuleManifest {
  return (
    value !== null &&
    (value as ReviewDocumentModuleManifestFailure).status !== "skipped"
  );
}

function getReviewDocumentManifestForDocument(
  document: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
  state: ReviewDocumentScanState,
  scanState: ReviewDocumentScanCancellation,
): Promise<ReviewDocumentModuleManifest | ReviewDocumentModuleManifestFailure> {
  const filePath = path.resolve(document.filePath);

  const inFlight = state.inFlightScans.get(filePath);
  if (inFlight) return inFlight;

  const next = reviewDocumentScanLimiter(() =>
    scanState.isCanceled
      ? Promise.resolve({
          status: "skipped",
          filePath,
        } as ReviewDocumentModuleManifestFailure)
      : ensureReviewDocumentManifest(document, input),
  )
    .then((manifest) => {
      if (isReviewDocumentManifest(manifest)) {
        state.cachedManifests.set(filePath, manifest);
      }
      return manifest;
    })
    .finally(() => {
      state.inFlightScans.delete(filePath);
    });
  state.inFlightScans.set(filePath, next);
  return next;
}

async function ensureReviewDocumentManifest(
  document: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
): Promise<ReviewDocumentModuleManifest | ReviewDocumentModuleManifestFailure> {
  const filePath = path.resolve(document.filePath);
  const metadata = reviewDocumentSourceMetadata(
    document.filePath,
    document.titleFallback,
  );
  const fallback = reviewDocumentModuleManifestFromMetadata(document, metadata);
  const cache = await readReviewDocumentScanCacheFromDisk({
    reviewRootPath: input.reviewRootPath,
    filePath,
    fileFingerprint: reviewDocumentFileFingerprint(filePath),
  });

  if (!cache) {
    return loadReviewDocumentManifestForDocument(
      document,
      input,
      metadata,
      null,
    );
  }

  const repoRoot = resolveReviewSoftwareMapRepoRootSafe(input);

  if (!repoRoot) {
    return fallback;
  }

  if (await isReviewDocumentScanCacheUsable(document, input, repoRoot, cache)) {
    return {
      ...cache.manifest,
      resolvedBaseRef:
        cache.manifest.resolvedBaseRef ?? cache.resolvedBaseRef ?? null,
      isDefault: document.slug === "",
      filePath,
    };
  }

  return loadReviewDocumentManifestForDocument(
    document,
    input,
    metadata,
    cache,
  );
}

async function loadReviewDocumentManifestForDocument(
  document: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
  metadata: ReturnType<typeof reviewDocumentSourceMetadata>,
  cached: ReviewDocumentScanCacheEntry | null,
): Promise<ReviewDocumentModuleManifest | ReviewDocumentModuleManifestFailure> {
  const filePath = path.resolve(document.filePath);
  const fileFingerprint = reviewDocumentFileFingerprint(filePath);
  const fallback = reviewDocumentModuleManifestFromMetadata(document, metadata);
  const review = readReviewStoreRecord(input.reviewRootPath);
  const storeRefs: [string, string] | null = review.sourceCommit
    ? [review.sourceCommit, review.baseCommit]
    : null;
  const isPinnedRefs = Boolean(storeRefs);
  const repoRoot = resolveReviewSoftwareMapRepoRootSafe(input);
  let resolvedHeadRef: string | null = null;
  let resolvedBaseRef: string | null = null;

  if (!repoRoot) {
    return fallback;
  }
  let resolvedCachedRefs: [string | null, string | null] | null = null;
  if (cached && isPinnedRefs) {
    resolvedCachedRefs =
      storeRefs ??
      (await resolveReviewDocumentRefs(repoRoot, input.reviewRootPath).catch(
        (): [string | null, string | null] => [null, null],
      ));
    if (
      await isReviewDocumentScanCacheUsable(
        document,
        input,
        repoRoot,
        cached,
        resolvedCachedRefs,
      )
    ) {
      return {
        ...cached.manifest,
        resolvedBaseRef:
          cached.manifest.resolvedBaseRef ?? cached.resolvedBaseRef ?? null,
        isDefault: document.slug === "",
        filePath,
      };
    }
  }

  if (storeRefs) {
    [resolvedHeadRef, resolvedBaseRef] = storeRefs;
  } else if (!isPinnedRefs) {
    [resolvedHeadRef, resolvedBaseRef] = await resolveReviewDocumentRefs(
      repoRoot,
      input.reviewRootPath,
    ).catch((): [string | null, string | null] => [null, null]);
  } else if (!resolvedCachedRefs) {
    [resolvedHeadRef, resolvedBaseRef] = await resolveReviewDocumentRefs(
      repoRoot,
      input.reviewRootPath,
    ).catch((): [string | null, string | null] => [null, null]);
  } else {
    [resolvedHeadRef, resolvedBaseRef] = resolvedCachedRefs;
  }

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

  if (isPinnedRefs) {
    await writeReviewDocumentScanCache({
      reviewRootPath: input.reviewRootPath,
      filePath,
      fileFingerprint,
      resolvedHeadRef: headRefForScan,
      resolvedBaseRef: baseRefForScan,
      manifest: result,
    }).catch(() => {});
  }

  return result;
}

async function readReviewDocumentScanCacheFromDisk(input: {
  reviewRootPath: string;
  filePath: string;
  fileFingerprint: ReviewDocumentScanFingerprintEntry;
}): Promise<ReviewDocumentScanCacheEntry | null> {
  const cachePath = reviewDocumentScanCachePath(
    input.reviewRootPath,
    input.filePath,
  );
  try {
    const serialized = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(serialized) as ReviewDocumentScanCacheEntry;
    if (parsed.version !== 1) return null;
    if (parsed.documentPath !== path.resolve(input.filePath)) return null;
    if (
      parsed.fileFingerprint.mtimeMs !== input.fileFingerprint.mtimeMs ||
      parsed.fileFingerprint.size !== input.fileFingerprint.size ||
      parsed.fileFingerprint.filePath !== path.resolve(input.filePath)
    ) {
      return null;
    }
    if (!parsed.manifest?.filePath) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function isReviewDocumentScanCacheUsable(
  document: ReviewDocumentInputWithMeta,
  input: ReviewDocumentScanInput,
  repoRootPath: string,
  cacheEntry: ReviewDocumentScanCacheEntry,
  resolvedRefs?: [string | null, string | null],
): Promise<boolean> {
  if (document.routePath !== cacheEntry.manifest.routePath) return false;
  if (
    document.filePath !== cacheEntry.manifest.filePath &&
    path.resolve(document.filePath) !==
      path.resolve(cacheEntry.manifest.filePath)
  ) {
    return false;
  }
  if (
    !cacheEntry.manifest.headSoftwareMapPath ||
    !cacheEntry.manifest.baseSoftwareMapPath
  ) {
    return false;
  }
  for (const candidate of [
    cacheEntry.manifest.headSoftwareMapPath,
    cacheEntry.manifest.baseSoftwareMapPath,
  ]) {
    if (candidate && !existsSync(candidate)) return false;
  }
  const [resolvedHeadRef, resolvedBaseRef] = await (resolvedRefs ??
    resolveReviewDocumentRefs(repoRootPath, input.reviewRootPath).catch(
      () => [null, null] as [string | null, string | null],
    ));
  return (
    cacheEntry.resolvedHeadRef === resolvedHeadRef &&
    cacheEntry.resolvedBaseRef === resolvedBaseRef
  );
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

async function writeReviewDocumentScanCache(input: {
  reviewRootPath: string;
  filePath: string;
  fileFingerprint: ReviewDocumentScanFingerprintEntry;
  resolvedHeadRef: string | null;
  resolvedBaseRef: string | null;
  manifest: ReviewDocumentModuleManifest;
}): Promise<void> {
  const cachePath = reviewDocumentScanCachePath(
    input.reviewRootPath,
    input.filePath,
  );
  const entry: ReviewDocumentScanCacheEntry = {
    version: 1,
    documentPath: path.resolve(input.filePath),
    fileFingerprint: input.fileFingerprint,
    resolvedHeadRef: input.resolvedHeadRef,
    resolvedBaseRef: input.resolvedBaseRef,
    manifest: {
      slug: input.manifest.slug,
      routePath: input.manifest.routePath,
      filePath: input.manifest.filePath,
      title: input.manifest.title,
      modelNames: input.manifest.modelNames,
      headSoftwareMapPath: input.manifest.headSoftwareMapPath,
      baseSoftwareMapPath: input.manifest.baseSoftwareMapPath,
      isDefault: input.manifest.isDefault,
    },
    updatedAtMs: Date.now(),
  };
  await mkdir(reviewDocumentScanCacheDir(input.reviewRootPath), {
    recursive: true,
  });
  writeFileAtomic(cachePath, JSON.stringify(entry), "utf8");
}

function reviewDocumentScanCacheDir(reviewRootPath: string): string {
  return path.dirname(
    reviewDocumentScanCachePath(reviewRootPath, "placeholder"),
  );
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
  const key = reviewDocumentScanCacheKey(normalized);
  const nextFingerprint = collectReviewDocumentScanFingerprint(normalized);
  const cached = reviewDocumentScanCache.get(key);

  if (
    !cached ||
    !reviewDocumentScanFingerprintsMatch(cached.fingerprint, nextFingerprint)
  ) {
    const scan = spanSync("collectReviewDocumentScan", () =>
      collectReviewDocumentScanInner(normalized, nextFingerprint),
    );
    reviewDocumentScanCache.set(key, { ...scan, fingerprint: nextFingerprint });
    return scan;
  }

  return {
    manifests: [...cached.manifests],
    softwareMapPaths: [...cached.softwareMapPaths],
    sourceRoots: [...cached.sourceRoots],
  };
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

function reviewDocumentScanCacheKey(input: ReviewDocumentScanInput): string {
  return JSON.stringify(input);
}

function reviewDocumentScanFingerprintsMatch(
  left: ReviewDocumentScanFingerprint,
  right: ReviewDocumentScanFingerprint,
): boolean {
  if (left.reviewStore.mtimeMs !== right.reviewStore.mtimeMs) return false;
  if (left.reviewStore.size !== right.reviewStore.size) return false;
  if (left.reviewDocument.mtimeMs !== right.reviewDocument.mtimeMs)
    return false;
  if (left.reviewDocument.size !== right.reviewDocument.size) return false;
  if (left.reviewDocuments.length !== right.reviewDocuments.length)
    return false;
  for (let i = 0; i < left.reviewDocuments.length; i++) {
    const leftEntry = left.reviewDocuments[i];
    const rightEntry = right.reviewDocuments[i];
    if (
      leftEntry.filePath !== rightEntry.filePath ||
      leftEntry.mtimeMs !== rightEntry.mtimeMs ||
      leftEntry.size !== rightEntry.size
    ) {
      return false;
    }
  }
  return true;
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
