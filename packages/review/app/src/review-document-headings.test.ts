import { describe, expect, it } from "vitest";

import {
  assignReviewHeadingIds,
  reviewTocEntries,
} from "./review-document-headings";
import type { HydratedReviewNode } from "./review-document-hydrate";

const text = (value: string) => ({ type: "text" as const, value });

const h = (
  tag: "h2" | "h3",
  value: string,
  id?: string,
): HydratedReviewNode => ({
  type: "element",
  tag,
  props: id === undefined ? {} : { id },
  children: [text(value)],
});

const section = (
  title: string,
  children: HydratedReviewNode[] = [],
): HydratedReviewNode => ({
  type: "component",
  name: "ReviewSection",
  props: { title },
  children,
});

describe("assignReviewHeadingIds", () => {
  it("slugs sections and loose headings once, in document order", () => {
    const body = [
      section("Data flow", [h("h3", "Details")]),
      h("h2", "Data flow"),
      section("Data flow"),
      h("h2", "", "authored"),
      h("h2", "☕"),
    ];

    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body)).toEqual([
      { id: "data-flow", text: "Data flow", level: "h2" },
      { id: "details", text: "Details", level: "h3" },
      { id: "data-flow-2", text: "Data flow", level: "h2" },
      { id: "data-flow-3", text: "Data flow", level: "h2" },
      { id: "section", text: "☕", level: "h2" },
    ]);
  });

  it("reserves authored ids before generating and is idempotent", () => {
    const body = [h("h2", "Shared", "shared"), section("Shared")];

    assignReviewHeadingIds(body);
    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body).map(({ id }) => id)).toEqual([
      "shared",
      "shared-2",
    ]);
  });
});
