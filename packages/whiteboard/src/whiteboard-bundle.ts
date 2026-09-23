import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import {
  type WhiteboardDocumentData,
  upgradeWhiteboardDocumentJson,
  whiteboardDocumentDataSchema,
} from "./whiteboard-document-data";

// The tutorial service and the stored-review migration write a built document
// bundle into the review dir and seal it with the revision. The desktop server
// serves these exact bytes from the materialized build dir; it never rebuilds a
// published document.
export const WHITEBOARD_BUNDLE_DIR = ".bundle";

export const WHITEBOARD_DOCUMENT_BUNDLE_DIR = path.join(
  WHITEBOARD_BUNDLE_DIR,
  "document",
);

const BUNDLE_JSON_FILE = "review-document.json";

const LEGACY_BUNDLE_CODE_FILE = "review-document.js";

const BUNDLE_MANIFEST_FILE = "manifest.json";

const BUNDLE_MANIFEST_VERSION = 2;

const whiteboardBundleManifestSchema = z.object({
  version: z.literal(BUNDLE_MANIFEST_VERSION),
  routePath: z.string(),
  sourcePath: z.string(),
});

type WhiteboardBundleManifest = z.infer<typeof whiteboardBundleManifestSchema>;

// The bundle is the bytes plus their hash. Route and source path live inside
// the document (and in the manifest that gates a read), so the bundle cannot
// disagree with itself.
export interface WhiteboardDocumentBundle {
  json: string;
  contentHash: string;
}

export function bundleWhiteboardDocument(
  document: WhiteboardDocumentData,
): WhiteboardDocumentBundle {
  const json = `${JSON.stringify(document)}\n`;

  return { json, contentHash: bundleHash(json) };
}

export function whiteboardDocumentBundleData(
  bundle: WhiteboardDocumentBundle,
): WhiteboardDocumentData {
  return whiteboardDocumentDataSchema.parse(parseJsonText(bundle.json));
}

export async function writeWhiteboardDocumentBundle(
  whiteboardDir: string,
  bundle: WhiteboardDocumentBundle,
): Promise<void> {
  const document = whiteboardDocumentBundleData(bundle);
  const bundleDir = path.join(whiteboardDir, WHITEBOARD_DOCUMENT_BUNDLE_DIR);
  await mkdir(bundleDir, { recursive: true, mode: 0o700 });

  const manifest: WhiteboardBundleManifest = {
    version: BUNDLE_MANIFEST_VERSION,
    routePath: document.routePath,
    sourcePath: document.sourcePath,
  };

  await Promise.all([
    writeFile(path.join(bundleDir, BUNDLE_JSON_FILE), bundle.json, "utf8"),
    writeFile(
      path.join(bundleDir, BUNDLE_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    rm(path.join(bundleDir, LEGACY_BUNDLE_CODE_FILE), { force: true }),
    rm(
      path.join(whiteboardDir, WHITEBOARD_BUNDLE_DIR, LEGACY_BUNDLE_CODE_FILE),
      {
        force: true,
      },
    ),
    rm(path.join(whiteboardDir, WHITEBOARD_BUNDLE_DIR, BUNDLE_MANIFEST_FILE), {
      force: true,
    }),
  ]);
}

export async function readWhiteboardDocumentBundle(
  documentDir: string,
  routePath: string,
): Promise<WhiteboardDocumentBundle | null> {
  const bundleDir = path.join(documentDir, WHITEBOARD_DOCUMENT_BUNDLE_DIR);
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
  let raw: string;

  try {
    raw = await readFile(path.join(bundleDir, BUNDLE_JSON_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const json = upgradeBundleJson(raw);

  if (json === null) return null;
  const document = parseDocument(json);

  if (document === null || document.routePath !== manifest.routePath)
    return null;

  return { json, contentHash: bundleHash(json) };
}

/** Older sealed bundles predate the plain-source anchor shape. Upgrading the
 * bytes before hashing keeps one document shape and, for current bundles, the
 * same hash as before. */
function upgradeBundleJson(raw: string): string | null {
  let value: JsonValue;

  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }

  return `${JSON.stringify(upgradeWhiteboardDocumentJson(value))}\n`;
}

function parseManifest(raw: string): WhiteboardBundleManifest | null {
  let value: JsonValue;

  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }

  const manifest = whiteboardBundleManifestSchema.safeParse(value);

  return manifest.success ? manifest.data : null;
}

function parseDocument(raw: string): WhiteboardDocumentData | null {
  let value: JsonValue;

  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }

  const document = whiteboardDocumentDataSchema.safeParse(value);

  return document.success ? document.data : null;
}

function bundleHash(json: string): string {
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 20);
}
