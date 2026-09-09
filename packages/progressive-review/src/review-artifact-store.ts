import crypto from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomicAsync } from "./atomic-write";
import { isMissingFileError } from "./native-agent/transcript-json";
import {
  type ReviewDocumentBundle,
  reviewDocumentBundleData,
  reviewDocumentContentHash,
} from "./review-bundle";
import {
  type ReviewSoftwareMapBundle,
  softwareMapBundleFromArtifact,
} from "./software-map-bundle";

/** Immutable content-addressed artifacts live under `<reviewDir>/artifacts/`,
 * managed only through this module; never authored or derived-deleted. */
export const REVIEW_ARTIFACTS_DIR = "artifacts";

export type ReviewArtifactKind = "document" | "map";

export function reviewArtifactPath(
  reviewDir: string,
  kind: ReviewArtifactKind,
  hash: string,
): string {
  return path.join(
    reviewDir,
    REVIEW_ARTIFACTS_DIR,
    kind === "document" ? "documents" : "maps",
    `${hash}.json`,
  );
}

/** Artifact identity: the full 64-hex sha256 of the exact stored bytes. */
export function reviewArtifactHash(bytes: string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export class ReviewArtifactConflictError extends Error {
  override readonly name = "ReviewArtifactConflictError";

  constructor(filePath: string) {
    super(
      `Artifact at ${filePath} already exists with different bytes than requested.`,
    );
  }
}

export class ReviewArtifactCorruptError extends Error {
  override readonly name = "ReviewArtifactCorruptError";

  constructor(filePath: string) {
    super(`Artifact at ${filePath} does not hash to its own file name.`);
  }
}

export interface ReviewArtifactInstallation {
  hash: string;
  path: string;
  reused: boolean;
}

/** Writes `bytes` at their content-addressed path, or confirms an existing
 * file there already holds the same bytes. Never overwrites: a same-hash
 * collision with different bytes (impossible for sha256, but not for a
 * tampered or foreign file) is a conflict, not a silent replace. */
export async function installReviewArtifact(
  reviewDir: string,
  kind: ReviewArtifactKind,
  bytes: string,
): Promise<ReviewArtifactInstallation> {
  const hash = reviewArtifactHash(bytes);
  const filePath = reviewArtifactPath(reviewDir, kind, hash);
  await rejectSymlink(filePath);
  const existing = await readFile(filePath, "utf8").catch((error) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (existing !== null) {
    if (existing !== bytes) throw new ReviewArtifactConflictError(filePath);
    return { hash, path: filePath, reused: true };
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomicAsync(filePath, bytes, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { hash, path: filePath, reused: false };
}

/** `null` when the artifact is absent; throws `ReviewArtifactCorruptError`
 * when the file's bytes no longer hash to the name it is stored under. */
export async function readReviewArtifactBytes(
  reviewDir: string,
  kind: ReviewArtifactKind,
  hash: string,
): Promise<string | null> {
  const filePath = reviewArtifactPath(reviewDir, kind, hash);
  let bytes: string;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  if (reviewArtifactHash(bytes) !== hash)
    throw new ReviewArtifactCorruptError(filePath);
  return bytes;
}

export async function readReviewDocumentArtifact(
  reviewDir: string,
  hash: string,
): Promise<ReviewDocumentBundle | null> {
  const json = await readReviewArtifactBytes(reviewDir, "document", hash);
  if (json === null) return null;
  const bundle: ReviewDocumentBundle = {
    json,
    contentHash: reviewDocumentContentHash(json),
  };
  reviewDocumentBundleData(bundle);
  return bundle;
}

export async function readReviewSoftwareMapArtifact(
  reviewDir: string,
  hash: string,
): Promise<ReviewSoftwareMapBundle | null> {
  const bytes = await readReviewArtifactBytes(reviewDir, "map", hash);
  if (bytes === null) return null;
  return softwareMapBundleFromArtifact(bytes);
}

async function rejectSymlink(filePath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new Error(`Refusing to write through a symlink at ${filePath}.`);
}
