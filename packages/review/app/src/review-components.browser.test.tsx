import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewSection } from "./review-components";
import {
  TEST_REVIEW_CONFIG,
  testReviewSession,
} from "./review-session-test-utils";
import { readReviewUiState, reviewUiStateKey } from "./review-ui-state";

let root: Root | null = null;

const session = testReviewSession();

function renderWithSession(node: React.ReactNode) {
  root?.render(
    <ReviewSessionProvider session={session}>{node}</ReviewSessionProvider>,
  );
}

describe("ReviewSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it("renders the title as the heading and every child as body", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      renderWithSession(
        <ReviewSection
          title="Testing"
          id="testing"
          defaultCollapsed
          summary={{ diagrams: 0, codeRefs: 0, paragraphs: 2 }}
        >
          <p>Persistence suites pass.</p>
          <p>The CLI keeps working.</p>
          <ol>
            <li>Existing JSON reviews are never migrated.</li>
          </ol>
        </ReviewSection>,
      );
    });

    const heading = container.querySelector(".review-section-heading h2");
    const body = container.querySelector(".review-section-body");

    expect(heading?.textContent).toBe("Testing");
    expect(heading?.id).toBe("testing");
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(body?.querySelectorAll(":scope > p, :scope > ol")).toHaveLength(3);
    expect(body).toHaveProperty("hidden", true);
    expect(container.querySelector(".review-section-meta")?.textContent).toBe(
      "2 paragraphs",
    );

    const toggle = container.querySelector<HTMLButtonElement>(
      ".review-section-toggle",
    );

    expect(toggle?.getAttribute("aria-label")).toBe("Expand Testing");
    act(() => toggle?.click());
    expect(body).toHaveProperty("hidden", false);
    expect(toggle?.getAttribute("aria-label")).toBe("Collapse Testing");
    expect(
      readReviewUiState(
        "session",
        reviewUiStateKey(TEST_REVIEW_CONFIG, "session", "section", "Testing"),
      ),
    ).toBe(false);
  });

  it("renders without an id when none was assigned", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      renderWithSession(
        <ReviewSection title="Loose">
          <p>Body copy.</p>
        </ReviewSection>,
      );
    });

    const heading = container.querySelector(".review-section-heading h2");

    expect(heading?.hasAttribute("id")).toBe(false);
    expect(container.querySelector(".review-section-body")?.textContent).toBe(
      "Body copy.",
    );
  });
});
