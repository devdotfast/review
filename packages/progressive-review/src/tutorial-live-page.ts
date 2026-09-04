import type { Spec } from "@json-render/core";

import { tutorialAnchorInputs } from "../tutorial/fixture";
import type { AnchorRef } from "./authoring";
import { liveReviewTutorialPropsSchema } from "./live-review-catalog";
import type { LiveReviewPage } from "./live-review-types";
import type { ReviewStateService } from "./server/review-state-service";
import { resolveReviewSourceRange } from "./source-range-resolver";

const TUTORIAL_ROOT_NODE_ID = "tutorial-root";
const TUTORIAL_ELEMENT_ID = "tutorial-content";
const TUTORIAL_TITLE = "Review Desktop: three-minute tour";

export async function ensureTutorialLiveReviewPage(input: {
  reviewDir: string;
  reviewId: string;
  sourceRootPath: string;
  state: Pick<ReviewStateService, "readPage" | "initialize">;
}): Promise<LiveReviewPage> {
  const existing = input.state.readPage(input.reviewDir);
  if (existing) {
    if (existing.id !== input.reviewId) {
      throw new Error("Tutorial live Review page does not match its Review");
    }
    return existing;
  }

  const anchors = Object.fromEntries(
    await Promise.all(
      Object.entries(tutorialAnchorInputs).map(
        async ([id, definition]): Promise<[string, AnchorRef]> => {
          const peekProps = definition.peek;
          const snapshot = await resolveReviewSourceRange({
            rootPath: input.sourceRootPath,
            root: { kind: "range", ...peekProps },
          });
          return [
            id,
            {
              __kind: "db-anchor-ref",
              id,
              title: definition.title,
              softwareMapPath: definition.softwareMapPath,
              peek: {
                __kind: "code-peek-ref",
                props: peekProps,
                resolution: { snapshot },
              },
            },
          ];
        },
      ),
    ),
  );
  const tutorialProps = liveReviewTutorialPropsSchema.parse({ anchors });
  const projection: Spec = {
    root: TUTORIAL_ROOT_NODE_ID,
    elements: {
      [TUTORIAL_ROOT_NODE_ID]: {
        type: "ReviewNode",
        props: {
          nodeId: TUTORIAL_ROOT_NODE_ID,
          depth: 0,
          title: TUTORIAL_TITLE,
        },
        children: [TUTORIAL_ELEMENT_ID],
      },
      [TUTORIAL_ELEMENT_ID]: {
        type: "Tutorial",
        props: tutorialProps,
        children: [],
      },
    },
  };
  const page: LiveReviewPage = {
    id: input.reviewId,
    rootNodeId: TUTORIAL_ROOT_NODE_ID,
    nodes: {
      [TUTORIAL_ROOT_NODE_ID]: {
        id: TUTORIAL_ROOT_NODE_ID,
        title: TUTORIAL_TITLE,
        source: "",
        children: [],
      },
    },
    version: 0,
    updatedAt: new Date().toISOString(),
    projection,
  };
  input.state.initialize(input.reviewDir, page);
  return page;
}
