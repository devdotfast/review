import type { ReviewDocumentBundle } from "../review-bundle";
import type { ReviewSoftwareMapBundle } from "../software-map-bundle";

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
 * served while it is validated.
 */
export type ReviewSessionArtifactOrigin =
  | {
      kind: "publication";
      publicationId: string;
      mapPublicationId: string | null;
    }
  | { kind: "candidate" };

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
  /**
   * When the presented bytes were published. A publication's clock is the
   * moment it was committed, not the mtime of the editable source it shares a
   * path with; left unset, the file answers instead.
   */
  documentUpdatedAtMs?: number;
  /**
   * The document file the session reports and attaches for diagnostics, and the
   * directory it renders from — `<reviewDir>/review.mdx` for every publication
   * and candidate. Thread writes never go here: they follow `stateReviewPath`.
   */
  sourcePath: string;
}
