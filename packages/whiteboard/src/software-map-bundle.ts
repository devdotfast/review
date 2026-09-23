import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import {
  type NormalizedSoftwareModel,
  SOFTWARE_MAP_DATA_FORMAT,
  type SoftwareModelData,
  softwareMapDataFileSchema,
  softwareModelData,
} from "./software-map-model";

export { SOFTWARE_MAP_DATA_FORMAT } from "./software-map-model";

export const WHITEBOARD_SOFTWARE_MAP_BUNDLE_DIR = path.join(
  ".bundle",
  "software-map",
);

const HEAD_MAP_FILE = "head-map.json";

const BASE_MAP_FILE = "base-map.json";

const MANIFEST_FILE = "manifest.json";

// Version 1 wrote ES modules (head-map.js / base-map.js). Version 2 writes
// JSON; a version-1 bundle reads as null and `whiteboard migrate apply` converts it.
const MANIFEST_VERSION = 2;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

const SoftwareMapBundleManifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  headCommit: z.string().regex(COMMIT_SHA_PATTERN),
  baseCommit: z.string().regex(COMMIT_SHA_PATTERN),
});

type SoftwareMapBundleManifest = z.infer<
  typeof SoftwareMapBundleManifestSchema
>;

export interface WhiteboardSoftwareMapBundle {
  headJson: string;
  baseJson: string;
  contentHash: string;
  headCommit: string;
  baseCommit: string;
}

export function bundleWhiteboardSoftwareMap(input: {
  head: NormalizedSoftwareModel;
  base: NormalizedSoftwareModel;
  headCommit: string;
  baseCommit: string;
}): WhiteboardSoftwareMapBundle {
  const head = softwareModelData(input.head);
  const base = softwareModelData(input.base);
  const headJson = softwareMapDataJson(head, "head");
  const baseJson = softwareMapDataJson(base, "base");

  return {
    headJson,
    baseJson,
    contentHash: bundleHash(headJson, baseJson),
    headCommit: input.headCommit,
    baseCommit: input.baseCommit,
  };
}

export async function writeWhiteboardSoftwareMapBundle(
  whiteboardDir: string,
  bundle: WhiteboardSoftwareMapBundle,
): Promise<void> {
  validateSoftwareMapJson(bundle.headJson, "head");
  validateSoftwareMapJson(bundle.baseJson, "base");

  const bundleDir = path.join(
    whiteboardDir,
    WHITEBOARD_SOFTWARE_MAP_BUNDLE_DIR,
  );

  await mkdir(bundleDir, { recursive: true, mode: 0o700 });

  const manifest: SoftwareMapBundleManifest = {
    version: MANIFEST_VERSION,
    headCommit: bundle.headCommit,
    baseCommit: bundle.baseCommit,
  };

  await Promise.all([
    writeFile(path.join(bundleDir, HEAD_MAP_FILE), bundle.headJson, "utf8"),
    writeFile(path.join(bundleDir, BASE_MAP_FILE), bundle.baseJson, "utf8"),
    writeFile(
      path.join(bundleDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
}

export async function readWhiteboardSoftwareMapBundle(
  rootDir: string,
): Promise<WhiteboardSoftwareMapBundle | null> {
  const bundleDir = path.join(rootDir, WHITEBOARD_SOFTWARE_MAP_BUNDLE_DIR);
  let manifestRaw: string;

  try {
    manifestRaw = await readFile(path.join(bundleDir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const manifest = parseJson(manifestRaw, SoftwareMapBundleManifestSchema);

  if (!manifest) return null;
  let headJson: string;
  let baseJson: string;

  try {
    [headJson, baseJson] = await Promise.all([
      readFile(path.join(bundleDir, HEAD_MAP_FILE), "utf8"),
      readFile(path.join(bundleDir, BASE_MAP_FILE), "utf8"),
    ]);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const head = parseJson(headJson, softwareMapDataFileSchema);
  const base = parseJson(baseJson, softwareMapDataFileSchema);

  if (!head || !base) return null;

  return {
    headJson,
    baseJson,
    contentHash: bundleHash(headJson, baseJson),
    headCommit: manifest.headCommit,
    baseCommit: manifest.baseCommit,
  };
}

function softwareMapDataJson(
  data: SoftwareModelData,
  side: "head" | "base",
): string {
  const json = `${JSON.stringify({ format: SOFTWARE_MAP_DATA_FORMAT, ...data })}\n`;
  validateSoftwareMapJson(json, side);

  return json;
}

function validateSoftwareMapJson(json: string, side: "head" | "base"): void {
  try {
    softwareMapDataFileSchema.parse(parseJsonText(json));
  } catch (cause) {
    throw new Error(
      `Invalid ${side} software map: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  let value: JsonValue;

  try {
    value = parseJsonText(raw);
  } catch {
    return null;
  }

  const parsed = schema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

function bundleHash(headJson: string, baseJson: string): string {
  return crypto
    .createHash("sha256")
    .update(headJson)
    .update("\0")
    .update(baseJson)
    .digest("hex")
    .slice(0, 20);
}
