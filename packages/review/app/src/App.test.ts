import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { a as ReviewMdxLink } from "./review-components";
import {
  reviewSessionElement,
  testReviewSession,
} from "./review-session-test-utils";
import { shouldCloseSidePeekForReviewView } from "./review-view-route";
import { selectActiveSoftwareMapModel } from "./software-map-selection";
import { defineSoftwareModel } from "./software-map/model";

const testSession = testReviewSession();

function renderWithTestSession(element: ReactElement): string {
  return renderToStaticMarkup(reviewSessionElement(testSession, element));
}

describe("review app initial view", () => {
  it("closes side peeks when leaving the rendered review document", () => {
    expect(shouldCloseSidePeekForReviewView("review")).toBe(false);
    expect(shouldCloseSidePeekForReviewView("map")).toBe(true);
    expect(shouldCloseSidePeekForReviewView("diff")).toBe(true);
  });
});

describe("review app software map selection", () => {
  it("selects the model that contains a side-peek map focus target", () => {
    const repoModel = defineSoftwareModel({
      systems: {
        repo: { label: "Repo map" },
      },
    });

    const documentModel = defineSoftwareModel({
      systems: {
        review: {
          label: "Review model",
          containers: {
            app: { label: "Review app" },
          },
        },
      },
    });

    expect(
      selectActiveSoftwareMapModel({
        softwareModels: [repoModel, documentModel],
        focusElementPath: "review.app",
      }),
    ).toBe(documentModel);
    expect(
      selectActiveSoftwareMapModel({
        softwareModels: [repoModel, documentModel],
      }),
    ).toBe(repoModel);
  });
});

describe("review app links", () => {
  it("opens ordinary review document links in a new tab by default", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReviewMdxLink,
        { href: "https://example.com/docs" },
        "Docs",
      ),
    );

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("preserves in-document hash links without new-tab defaults", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewMdxLink, { href: "#summary" }, "Summary"),
    );

    expect(html).toContain('href="#summary"');
    expect(html).not.toContain("target=");
    expect(html).not.toContain("rel=");
  });
});
