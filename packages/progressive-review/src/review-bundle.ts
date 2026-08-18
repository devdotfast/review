import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReviewDocumentBundle } from "./server/doc-bundler";

// `review publish` writes the built document bundle into the review dir and
// seals it with the revision. The desktop server serves these exact bytes from
// the materialized build dir; it never rebuilds a published document.
export const REVIEW_BUNDLE_DIR = ".bundle";
export const REVIEW_DOCUMENT_BUNDLE_DIR = path.join(
  REVIEW_BUNDLE_DIR,
  "document",
);
const BUNDLE_CODE_FILE = "review-document.js";
const BUNDLE_MANIFEST_FILE = "manifest.json";
const BUNDLE_MANIFEST_VERSION = 1;

interface ReviewBundleManifest {
  version: number;
  routePath: string;
  sourcePath: string;
}

export async function writeReviewDocumentBundle(
  reviewDir: string,
  bundle: ReviewDocumentBundle,
): Promise<void> {
  const bundleDir = path.join(reviewDir, REVIEW_DOCUMENT_BUNDLE_DIR);
  await mkdir(bundleDir, { recursive: true, mode: 0o700 });
  const manifest: ReviewBundleManifest = {
    version: BUNDLE_MANIFEST_VERSION,
    routePath: bundle.routePath,
    sourcePath: path.basename(bundle.sourcePath),
  };
  await Promise.all([
    writeFile(path.join(bundleDir, BUNDLE_CODE_FILE), bundle.code, "utf8"),
    writeFile(
      path.join(bundleDir, BUNDLE_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    rm(path.join(reviewDir, REVIEW_BUNDLE_DIR, BUNDLE_CODE_FILE), {
      force: true,
    }),
    rm(path.join(reviewDir, REVIEW_BUNDLE_DIR, BUNDLE_MANIFEST_FILE), {
      force: true,
    }),
  ]);
}

export async function readReviewDocumentBundle(
  documentDir: string,
  routePath: string,
): Promise<ReviewDocumentBundle | null> {
  const bundleDir = path.join(documentDir, REVIEW_DOCUMENT_BUNDLE_DIR);
  let manifestRaw: string;
  let code: string;
  try {
    [manifestRaw, code] = await Promise.all([
      readFile(path.join(bundleDir, BUNDLE_MANIFEST_FILE), "utf8"),
      readFile(path.join(bundleDir, BUNDLE_CODE_FILE), "utf8"),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = parseManifest(manifestRaw);
  if (manifest === null || manifest.routePath !== routePath) return null;
  return {
    code,
    contentHash: crypto
      .createHash("sha256")
      .update(code)
      .digest("hex")
      .slice(0, 20),
    routePath: manifest.routePath,
    sourcePath: path.join(documentDir, manifest.sourcePath),
  };
}

function parseManifest(raw: string): ReviewBundleManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Partial<ReviewBundleManifest>;
  if (
    manifest.version !== BUNDLE_MANIFEST_VERSION ||
    typeof manifest.routePath !== "string" ||
    typeof manifest.sourcePath !== "string"
  ) {
    return null;
  }
  return manifest as ReviewBundleManifest;
}
