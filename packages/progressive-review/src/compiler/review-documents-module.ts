import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  currentHead as currentHeadAsync,
  gitCommonDirSync,
  resolveRevision as resolveRevisionAsync,
} from "@dev.fast/local-vcs";

import { reviewDocumentRoutePathForFile } from "../review-paths";
import {
  readReviewStoreRecord,
  resolveReviewRepoRootFromStore,
} from "../review-worktree-target";
import { materializeSoftwareMapAtRef } from "../software-map-artifact";

export const REVIEW_AUTHORING_MODULE_ID =
  "virtual:progressive-review-authoring";

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

interface ReviewDocumentScanResult {
  manifests: ReviewDocumentModuleManifest[];
  softwareMapPaths: string[];
  sourceRoots: string[];
}

interface ReviewDocumentSoftwareMapPaths {
  headSoftwareMapPath: string | null;
  baseSoftwareMapPath: string | null;
}

interface ReviewDocumentSourceMetadata {
  title: string;
  modelNames: string[];
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

export function collectReviewDocumentScanForRuntime(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): Promise<ReviewDocumentScanResult> {
  return collectReviewDocumentScanForRuntimeInner(input);
}

async function collectReviewDocumentScanForRuntimeInner(input: {
  reviewPath: string;
  reviewDocumentsDir: string;
  reviewRootPath: string;
}): Promise<ReviewDocumentScanResult> {
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
}

function reviewDocumentModuleManifestFromMetadata(
  document: ReviewDocumentInputWithMeta,
  metadata: ReviewDocumentSourceMetadata,
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
}): Promise<ReviewDocumentSoftwareMapPaths> {
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
): ReviewDocumentSourceMetadata {
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
