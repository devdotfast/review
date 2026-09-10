import {
  type ReviewDocumentBundle,
  readReviewDocumentBundle,
} from "../review-bundle";
import {
  type ReviewSoftwareMapBundle,
  readReviewSoftwareMapBundle,
} from "../software-map-bundle";

export const NEEDS_REPUBLISH_ERROR =
  "This review was published by an earlier version of Review and its document must be regenerated.";
export const NEEDS_REPUBLISH_MAP_ERROR =
  "This review's software map must be regenerated.";
export const HISTORICAL_UNAVAILABLE_ERROR =
  "This older revision is unavailable in this version of Review";

/**
 * Where a session's bytes come from.
 *
 * `publication` is a committed publication the session serves for as long as it lives;
 * `candidate` is a staged one the app mounts to validate, and only its own bytes may be
 * served while it is validated. `legacy` is the Git-era materialization of a revision
 * into a build directory, which the artifact store replaces.
 */
export type ReviewSessionArtifactOrigin =
  | {
      kind: "publication";
      publicationId: string;
      mapPublicationId: string | null;
    }
  | { kind: "candidate" }
  | { kind: "legacy"; revision: string; buildDir: string };

/** The sealed document, or the reason the session cannot serve one. */
export type ReviewSessionArtifactDocument =
  | { bundle: ReviewDocumentBundle }
  | { unavailable: string };

/** The published map, or the reason the session cannot serve it. */
export type ReviewSessionArtifactMap =
  | { bundle: ReviewSoftwareMapBundle }
  | { unavailable: string };

/** Everything a session presents, resolved before the session exists. */
export interface ReviewSessionArtifactInput {
  reviewUuid: string;
  origin: ReviewSessionArtifactOrigin;
  document: ReviewSessionArtifactDocument;
  /** Absent when no map is published; present and unavailable when one is stale. */
  map?: ReviewSessionArtifactMap;
  title: string | undefined;
  /** `<reviewDir>/review.mdx` — diagnostics and authoring actions only. */
  sourcePath: string;
}

export interface LegacySessionArtifactInput {
  reviewUuid: string;
  revision: string;
  buildDir: string;
  routePath: string;
  softwareMapRootPath?: string | null;
  sourcePath: string;
  /** Reported instead of reading the build directory when the revision itself
   * could not be materialized. */
  documentUnavailable?: string;
  softwareMapUnavailable?: string;
  /** A historical open reports a missing bundle in its own words. */
  historical?: boolean;
}

/**
 * Reads the bundles a materialized revision left in its build directory.
 *
 * The single place a session's bytes still come from `.build/<revision>/.bundle`;
 * publications replace it once the serving path reads the artifact store.
 */
export async function legacySessionArtifactFromBuildDir(
  input: LegacySessionArtifactInput,
): Promise<ReviewSessionArtifactInput> {
  const staleDocument = input.historical
    ? HISTORICAL_UNAVAILABLE_ERROR
    : NEEDS_REPUBLISH_ERROR;
  const staleMap = input.historical
    ? HISTORICAL_UNAVAILABLE_ERROR
    : NEEDS_REPUBLISH_MAP_ERROR;
  const [document, map] = await Promise.all([
    readLegacyDocument(input, staleDocument),
    readLegacyMap(input, staleMap),
  ]);
  return {
    reviewUuid: input.reviewUuid,
    origin: {
      kind: "legacy",
      revision: input.revision,
      buildDir: input.buildDir,
    },
    document,
    map,
    title: undefined,
    sourcePath: input.sourcePath,
  };
}

async function readLegacyDocument(
  input: LegacySessionArtifactInput,
  staleMessage: string,
): Promise<ReviewSessionArtifactDocument> {
  if (input.documentUnavailable) {
    return { unavailable: input.documentUnavailable };
  }
  const bundle = await readReviewDocumentBundle(
    input.buildDir,
    input.routePath,
  );
  return bundle ? { bundle } : { unavailable: staleMessage };
}

async function readLegacyMap(
  input: LegacySessionArtifactInput,
  staleMessage: string,
): Promise<ReviewSessionArtifactMap | undefined> {
  if (input.softwareMapUnavailable) {
    return { unavailable: input.softwareMapUnavailable };
  }
  if (!input.softwareMapRootPath) return undefined;
  const bundle = await readReviewSoftwareMapBundle(input.softwareMapRootPath);
  return bundle ? { bundle } : { unavailable: staleMessage };
}
