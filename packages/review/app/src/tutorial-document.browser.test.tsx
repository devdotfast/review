import {
  type ReviewCanvasTutorialBridge,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { Children, type ReactNode, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { reviewDocumentDataSchema } from "../../src/review-document-data";
import tutorialDocument from "../../tutorial/.bundle/document/review-document.json";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import { ReviewSessionProvider } from "./host/review-session";
import { reviewAuthoringComponents } from "./review-authoring-components";
import { ReviewProvider } from "./review-context";
import { testCodePeekResolution } from "./review-definition-test-utils";
import { hydrateReviewDocument } from "./review-document-hydrate";
import { renderReviewNodes } from "./review-document-renderer";
import { reviewDocumentComponents } from "./review-document-surface";
import { ReviewPanelProvider } from "./review-panel";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";

const expectedComponents = [
  "AnchorLink",
  "CodePeek",
  "DatabaseLens",
  "DbUseCase",
  "DbWrite",
  "ReviewSection",
  "SequenceDiagram",
  "TraceQuote",
  "TutorialAuthoringConversation",
  "TutorialFeature",
  "TutorialKeymapPicker",
  "TutorialViewButton",
];

const tutorial: ReviewCanvasTutorialBridge = {
  content: {
    reviewUuid: "tutorial-review",
    progress: { version: 1, checked: [], dismissed: false },
    keymap: "none",
  },
  setStep() {},
  dismiss() {},
  reopen() {},
  async selectKeymap() {},
  close() {},
};

describe("shipped tutorial JSON document", () => {
  it("hydrates and renders the real registry with contiguous prose block identities", async () => {
    const data = reviewDocumentDataSchema.parse(tutorialDocument);

    const hydrated = hydrateReviewDocument({
      state: "ready",
      contentHash: "tutorial-fixture",
      data: parseJsonText(JSON.stringify(data)),
    });

    for (const anchor of hydrated.anchors.values()) {
      if (anchor.peek) anchor.peek.resolution = testCodePeekResolution();
    }

    const rendered = renderReviewNodes(hydrated.body, reviewDocumentComponents);
    const components = new Set<string>();

    const visit = (node: ReactNode): void => {
      Children.forEach(node, (child) => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return;

        for (const [name, component] of Object.entries(
          reviewAuthoringComponents,
        )) {
          if (child.type === component) components.add(name);
        }

        visit(child.props.children);
      });
    };

    visit(rendered);
    expect([...components].sort()).toEqual(expectedComponents);

    const html = renderToStaticMarkup(
      <ReviewSessionProvider session={testReviewSession()}>
        <ReviewDebugSettingsProvider>
          <ReviewProvider softwareMapEnabled>
            <TutorialProvider tutorial={tutorial}>
              <ReviewPanelProvider detailRevision={hydrated.contentHash}>
                {rendered}
              </ReviewPanelProvider>
            </TutorialProvider>
          </ReviewProvider>
        </ReviewDebugSettingsProvider>
      </ReviewSessionProvider>,
    );

    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector(".tutorial-keymap-picker")).not.toBeNull();
    expect(
      container.querySelector(".tutorial-authoring-conversation"),
    ).not.toBeNull();
  });
});
