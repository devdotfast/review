import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type NormalizedSoftwareModel,
  type SoftwareModelData,
  softwareModelData,
  softwareModelDataSchema,
} from "./software-map-model";

export const REVIEW_SOFTWARE_MAP_BUNDLE_DIR = path.join(
  ".bundle",
  "software-map",
);
export const SOFTWARE_MAP_DATA_FORMAT = "software-map/1";
const HEAD_MAP_FILE = "head-map.json";
const BASE_MAP_FILE = "base-map.json";
const MANIFEST_FILE = "manifest.json";
// Version 1 wrote ES modules (head-map.js / base-map.js). Version 2 writes
// JSON; a version-1 bundle reads as null and `review migrate apply` converts it.
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
const SoftwareMapDataFileSchema = softwareModelDataSchema.extend({
  format: z.literal(SOFTWARE_MAP_DATA_FORMAT),
});

export interface ReviewSoftwareMapBundle {
  headJson: string;
  baseJson: string;
  contentHash: string;
  headCommit: string;
  baseCommit: string;
}

export function bundleReviewSoftwareMap(input: {
  head: NormalizedSoftwareModel;
  base: NormalizedSoftwareModel;
  headCommit: string;
  baseCommit: string;
}): ReviewSoftwareMapBundle {
  const head = softwareModelData(input.head);
  const base = softwareModelData(input.base);
  const headJson = softwareMapDataJson(head);
  const baseJson = softwareMapDataJson(base);
  return {
    headJson,
    baseJson,
    contentHash: bundleHash(headJson, baseJson),
    headCommit: input.headCommit,
    baseCommit: input.baseCommit,
  };
}

export async function writeReviewSoftwareMapBundle(
  reviewDir: string,
  bundle: ReviewSoftwareMapBundle,
): Promise<void> {
  const bundleDir = path.join(reviewDir, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
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

export async function readReviewSoftwareMapBundle(
  rootDir: string,
): Promise<ReviewSoftwareMapBundle | null> {
  const bundleDir = path.join(rootDir, REVIEW_SOFTWARE_MAP_BUNDLE_DIR);
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
  const head = parseJson(headJson, SoftwareMapDataFileSchema);
  const base = parseJson(baseJson, SoftwareMapDataFileSchema);
  if (!head || !base) return null;
  return {
    headJson,
    baseJson,
    contentHash: bundleHash(headJson, baseJson),
    headCommit: manifest.headCommit,
    baseCommit: manifest.baseCommit,
  };
}

export const SOFTWARE_MAP_ARTIFACT_FORMAT = "review-map-artifact/1";

const SoftwareMapArtifactEnvelopeSchema = z.strictObject({
  format: z.literal(SOFTWARE_MAP_ARTIFACT_FORMAT),
  headCommit: z.string().regex(COMMIT_SHA_PATTERN),
  baseCommit: z.string().regex(COMMIT_SHA_PATTERN),
  headJson: z.string(),
  baseJson: z.string(),
});
type SoftwareMapArtifactEnvelope = z.infer<
  typeof SoftwareMapArtifactEnvelopeSchema
>;

/** The on-disk bytes for a map artifact file: head/base JSON plus the
 * commits they were compared against, in one content-addressed envelope. */
export function softwareMapArtifactBytes(
  bundle: ReviewSoftwareMapBundle,
): string {
  const envelope: SoftwareMapArtifactEnvelope = {
    format: SOFTWARE_MAP_ARTIFACT_FORMAT,
    headCommit: bundle.headCommit,
    baseCommit: bundle.baseCommit,
    headJson: bundle.headJson,
    baseJson: bundle.baseJson,
  };
  return `${JSON.stringify(envelope)}\n`;
}

/** The inverse of `softwareMapArtifactBytes`; `null` on malformed or
 * incompatible bytes. `contentHash` is recomputed identically to
 * `readReviewSoftwareMapBundle`'s, so the two agree for the same maps. */
export function softwareMapBundleFromArtifact(
  bytes: string,
): ReviewSoftwareMapBundle | null {
  const envelope = parseJson(bytes, SoftwareMapArtifactEnvelopeSchema);
  if (!envelope) return null;
  const head = parseJson(envelope.headJson, SoftwareMapDataFileSchema);
  const base = parseJson(envelope.baseJson, SoftwareMapDataFileSchema);
  if (!head || !base) return null;
  return {
    headJson: envelope.headJson,
    baseJson: envelope.baseJson,
    contentHash: bundleHash(envelope.headJson, envelope.baseJson),
    headCommit: envelope.headCommit,
    baseCommit: envelope.baseCommit,
  };
}

export function sameReviewSoftwareMapBundle(
  left: ReviewSoftwareMapBundle,
  right: ReviewSoftwareMapBundle,
): boolean {
  return (
    left.headJson === right.headJson &&
    left.baseJson === right.baseJson &&
    left.headCommit === right.headCommit &&
    left.baseCommit === right.baseCommit
  );
}

function softwareMapDataJson(data: SoftwareModelData): string {
  return `${JSON.stringify({ format: SOFTWARE_MAP_DATA_FORMAT, ...data })}\n`;
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
