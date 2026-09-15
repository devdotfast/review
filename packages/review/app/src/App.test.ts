import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodePeekCard, validatedCodePeekInputFromRef } from "./CodePeek";
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

describe("review app CodePeek rendering", () => {
  it("leaves resolved CodePeek identity and stats to the native editor header", () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: { file: "src/example.ts", fromLine: 1, toLine: 3, graph: "base" },
      resolution: {
        snapshot: {
          roots: [
            {
              kind: "source",
              sourceId: "source-range:src/old.ts:12-14",
            },
          ],
          resolved: {
            "source-range:src/old.ts:12-14": {
              source: {
                id: "source-range:src/old.ts:12-14",
                name: "old.ts L12-L14",
                kind: "source-range",
                file: "src/old.ts",
                line: 12,
                endLine: 14,
              },
              lines: [[{ t: "SECRET_SNAPSHOT_SOURCE", k: "t" }]],
            },
          },
        },
      },
    });

    const html = renderWithTestSession(createElement(CodePeekCard, { input }));

    expect(html).toContain('data-code-rendering="inline-editor"');
    expect(html).not.toContain("code-peek-card");
    expect(html).not.toContain("ReviewWorkbench");
    expect(html).not.toContain("src/old.ts:12–14");
    expect(html).not.toContain("src/old.ts → src/new.ts");
    expect(html).not.toContain("diff counts");
    expect(html).not.toContain("SECRET_SNAPSHOT_SOURCE");
  });

  it("renders a no-diff CodePeek without a duplicate React header", () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: { file: "src/unchanged.ts", fromLine: 8, toLine: 8 },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });

    const html = renderWithTestSession(createElement(CodePeekCard, { input }));

    expect(html).toContain('data-review-inline-editor="src/unchanged.ts"');
    expect(html).not.toContain("code-peek-card");
    expect(html).not.toContain("src/unchanged.ts:8");
    expect(html).not.toContain("Open in editor");
    expect(html).not.toContain("diff counts");
  });
});
