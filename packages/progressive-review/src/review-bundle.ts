import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type ReviewDocumentData,
  reviewDocumentDataSchema,
} from "./review-document-data";

// `review publish` writes the built document bundle into the review dir and
// seals it with the revision. The desktop server serves these exact bytes from
// the materialized build dir; it never rebuilds a published document.
export const REVIEW_BUNDLE_DIR = ".bundle";
export const REVIEW_DOCUMENT_BUNDLE_DIR = path.join(
  REVIEW_BUNDLE_DIR,
  "document",
);
const BUNDLE_JSON_FILE = "review-document.json";
const LEGACY_BUNDLE_CODE_FILE = "review-document.js";
const BUNDLE_MANIFEST_FILE = "manifest.json";
const BUNDLE_MANIFEST_VERSION = 2;

const reviewBundleManifestSchema = z.object({
  version: z.literal(BUNDLE_MANIFEST_VERSION),
  routePath: z.string(),
  sourcePath: z.string(),
});
type ReviewBundleManifest = z.infer<typeof reviewBundleManifestSchema>;

export interface ReviewDocumentBundle {
  document: ReviewDocumentData;
  json: string;
  contentHash: string;
  routePath: string;
  sourcePath: string;
}

export function bundleReviewDocument(
  document: ReviewDocumentData,
): ReviewDocumentBundle {
  const json = `${JSON.stringify(document)}\n`;
  return {
    document,
    json,
    contentHash: bundleHash(json),
    routePath: document.routePath,
    sourcePath: document.sourcePath,
  };
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
    sourcePath: bundle.sourcePath,
  };
  await Promise.all([
    writeFile(path.join(bundleDir, BUNDLE_JSON_FILE), bundle.json, "utf8"),
    writeFile(
      path.join(bundleDir, BUNDLE_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    rm(path.join(bundleDir, LEGACY_BUNDLE_CODE_FILE), { force: true }),
    rm(path.join(reviewDir, REVIEW_BUNDLE_DIR, LEGACY_BUNDLE_CODE_FILE), {
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
  try {
    manifestRaw = await readFile(
      path.join(bundleDir, BUNDLE_MANIFEST_FILE),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const manifest = parseManifest(manifestRaw);
  if (manifest === null || manifest.routePath !== routePath) return null;
  let json: string;
  try {
    json = await readFile(path.join(bundleDir, BUNDLE_JSON_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const document = parseDocument(json);
  if (document === null) return null;
  return {
    document,
    json,
    contentHash: bundleHash(json),
    routePath: manifest.routePath,
    sourcePath: manifest.sourcePath,
  };
}

function parseManifest(raw: string): ReviewBundleManifest | null {
  let value: JsonValue;
  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }
  const manifest = reviewBundleManifestSchema.safeParse(value);
  return manifest.success ? manifest.data : null;
}

function parseDocument(raw: string): ReviewDocumentData | null {
  let value: JsonValue;
  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }
  const document = reviewDocumentDataSchema.safeParse(value);
  return document.success ? document.data : null;
}

function bundleHash(json: string): string {
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 20);
}
