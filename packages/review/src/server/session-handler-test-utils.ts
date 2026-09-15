import {
  REVIEW_DOCUMENT_FORMAT,
  type ReviewDocumentData,
} from "../review-document-data";
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

export const NEEDS_REPUBLISH_ERROR =
  "This review was published by an earlier version of Review and its document must be regenerated.";
