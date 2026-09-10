import path from "node:path";

import {
  bundleReviewDocument,
  readReviewDocumentBundle,
} from "../review-bundle";
import {
  REVIEW_DOCUMENT_FORMAT,
  type ReviewDocumentData,
} from "../review-document-data";
import { readReviewSoftwareMapBundle } from "../software-map-bundle";
import {
  HISTORICAL_UNAVAILABLE_ERROR,
  NEEDS_REPUBLISH_MAP_ERROR,
  type ReviewSessionArtifactDocument,
  type ReviewSessionArtifactInput,
  type ReviewSessionArtifactMap,
  type ReviewSessionArtifactOrigin,
} from "./review-session-artifact";
import type { ReviewSessionHandlerInput } from "./session-handler";

export const unusedAgentServices = {
  agentServer: () => {
    throw new Error("This test does not launch a native agent.");
  },
  openNativeAgentTerminal: async () => {
    throw new Error("This test does not open a native agent terminal.");
  },
} satisfies Pick<
  ReviewSessionHandlerInput,
  "agentServer" | "openNativeAgentTerminal"
>;

export const reviewDocument: ReviewDocumentData = {
  format: REVIEW_DOCUMENT_FORMAT,
  title: "Review",
  routePath: "/",
  sourcePath: "review.mdx",
  body: [],
  anchors: {},
  anchorContents: {},
  softwareModels: [],
};

/* Spelled out rather than imported from `review-session-artifact.ts`: this is a
   message readers see, so the assertions that use it must fail when it changes. */
export const NEEDS_REPUBLISH_ERROR =
  "This review was published by an earlier version of Review and its document must be regenerated.";

export interface SessionArtifactFixtureInput {
  sourcePath: string;
  reviewUuid?: string;
  origin?: ReviewSessionArtifactOrigin;
  document?: ReviewSessionArtifactDocument;
  map?: ReviewSessionArtifactMap;
  title?: string;
}

/** A healthy publication artifact; tests state the parts they care about. */
export function sessionArtifactFixture(
  input: SessionArtifactFixtureInput,
): ReviewSessionArtifactInput {
  return {
    reviewUuid: input.reviewUuid ?? "11111111-1111-4111-8111-111111111111",
    origin: input.origin ?? {
      kind: "publication",
      publicationId: "c".repeat(40),
      mapPublicationId: null,
    },
    document: input.document ?? {
      bundle: bundleReviewDocument(reviewDocument),
    },
    map: input.map,
    title: input.title,
    sourcePath: input.sourcePath,
  };
}

export interface BundleDirArtifactInput {
  reviewUuid: string;
  publicationId: string;
  /** A directory holding a `.bundle/` tree, as `writeReviewDocumentBundle` writes it. */
  bundleDir: string;
  routePath: string;
  softwareMapRootPath?: string | null;
  documentUnavailable?: string;
  softwareMapUnavailable?: string;
  /** A historical open reports a missing bundle in its own words. */
  historical?: boolean;
}

/**
 * Builds a session artifact from bundles on disk. Production resolves a
 * publication's bytes from the artifact store; these tests exercise the
 * handler, so they hand it the bundles a directory holds.
 */
export async function sessionArtifactFromBundleDir(
  input: BundleDirArtifactInput,
): Promise<ReviewSessionArtifactInput> {
  const staleMap = input.historical
    ? HISTORICAL_UNAVAILABLE_ERROR
    : NEEDS_REPUBLISH_MAP_ERROR;
  const [document, map] = await Promise.all([
    bundleDirDocument(input),
    bundleDirMap(input, staleMap),
  ]);
  const artifact: ReviewSessionArtifactInput = {
    reviewUuid: input.reviewUuid,
    origin: {
      kind: "publication",
      publicationId: input.publicationId,
      mapPublicationId: input.softwareMapRootPath ? "d".repeat(40) : null,
    },
    document,
    title: undefined,
    sourcePath: path.join(input.bundleDir, "review.mdx"),
  };
  if (map) artifact.map = map;
  return artifact;
}

async function bundleDirDocument(
  input: BundleDirArtifactInput,
): Promise<ReviewSessionArtifactDocument> {
  if (input.documentUnavailable) {
    return { unavailable: input.documentUnavailable };
  }
  const bundle = await readReviewDocumentBundle(
    input.bundleDir,
    input.routePath,
  );
  if (bundle) return { bundle };
  return {
    unavailable: input.historical
      ? HISTORICAL_UNAVAILABLE_ERROR
      : NEEDS_REPUBLISH_ERROR,
  };
}

async function bundleDirMap(
  input: BundleDirArtifactInput,
  staleMessage: string,
): Promise<ReviewSessionArtifactMap | undefined> {
  if (input.softwareMapUnavailable) {
    return { unavailable: input.softwareMapUnavailable };
  }
  if (!input.softwareMapRootPath) return undefined;
  const bundle = await readReviewSoftwareMapBundle(input.softwareMapRootPath);
  return bundle ? { bundle } : { unavailable: staleMessage };
}
