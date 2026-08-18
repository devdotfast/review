// @vitest-environment jsdom

import { type ComponentPropsWithoutRef, act } from "react";
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
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it("keeps every body child when the compiled heading is missing", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      renderWithSession(
        <ReviewSection title="Testing" defaultCollapsed>
          <p data-review-block-index="4" data-review-block-tag="p">
            Persistence suites pass.
          </p>
          <p data-review-block-index="5" data-review-block-tag="p">
            The threads CLI keeps working.
          </p>
          <ol data-review-block-index="6" data-review-block-tag="ol">
            <li>Existing JSON reviews are never migrated.</li>
          </ol>
        </ReviewSection>,
      );
    });

    const heading = container.querySelector(".review-section-heading");
    const body = container.querySelector(".review-section-body");

    expect(heading?.querySelector("h2")?.textContent).toBe("Testing");
    expect(heading?.querySelector("p, ol")).toBeNull();
    expect(body?.querySelectorAll(":scope > p, :scope > ol")).toHaveLength(3);
    expect(body?.querySelector("p")?.dataset.reviewBlockIndex).toBe("4");
    expect(body?.querySelector("ol")?.dataset.reviewBlockIndex).toBe("6");
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

  it("reuses a compiled h2 and puts only following children in the body", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      renderWithSession(
        <ReviewSection title="Decision log">
          <h2
            id="decision-log"
            data-review-block-index="8"
            data-review-block-tag="h2"
          >
            Decision log
          </h2>
          <p data-review-block-index="9" data-review-block-tag="p">
            Existing JSON reviews are never migrated.
          </p>
        </ReviewSection>,
      );
    });

    const heading = container.querySelector(".review-section-heading h2");
    const body = container.querySelector(".review-section-body");

    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(heading?.id).toBe("decision-log");
    expect(heading?.getAttribute("data-review-block-index")).toBe("8");
    expect(body?.querySelector("h2")).toBeNull();
    expect(body?.querySelector("p")?.dataset.reviewBlockIndex).toBe("9");
  });

  it("recognizes an MDX heading component by its stamped block tag", () => {
    function MdxHeading({
      children,
      ...props
    }: ComponentPropsWithoutRef<"h2">) {
      return <h2 {...props}>{children}</h2>;
    }

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      renderWithSession(
        <ReviewSection title="Interface change">
          <MdxHeading data-review-block-index="2" data-review-block-tag="h2">
            Interface change
          </MdxHeading>
          <p>Body copy.</p>
        </ReviewSection>,
      );
    });

    const heading = container.querySelector(".review-section-heading h2");
    const body = container.querySelector(".review-section-body");

    expect(heading?.textContent).toBe("Interface change");
    expect(heading?.getAttribute("data-review-block-index")).toBe("2");
    expect(body?.textContent).toBe("Body copy.");
  });
});
