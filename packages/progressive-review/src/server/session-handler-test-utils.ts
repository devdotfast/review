import path from "node:path";

import { bundleReviewDocument } from "../review-bundle";
import {
  REVIEW_DOCUMENT_FORMAT,
  type ReviewDocumentData,
} from "../review-document-data";
import type {
  ReviewSessionArtifactDocument,
  ReviewSessionArtifactInput,
  ReviewSessionArtifactMap,
  ReviewSessionArtifactOrigin,
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

/** A healthy legacy-origin artifact; tests state the parts they care about. */
export function sessionArtifactFixture(
  input: SessionArtifactFixtureInput,
): ReviewSessionArtifactInput {
  return {
    reviewUuid: input.reviewUuid ?? "11111111-1111-4111-8111-111111111111",
    origin: input.origin ?? {
      kind: "legacy",
      revision: "c".repeat(40),
      buildDir: path.dirname(input.sourcePath),
    },
    document: input.document ?? {
      bundle: bundleReviewDocument(reviewDocument),
    },
    map: input.map,
    title: input.title,
    sourcePath: input.sourcePath,
  };
}
