import { expect, it } from "vitest";

import type { HydratedReviewNode } from "./review-document-hydrate";
import { reviewSectionSummary } from "./review-section-summary";

const p: HydratedReviewNode = {
  type: "element",
  tag: "p",
  props: {},
  children: [],
};

const component = (
  name:
    | "SequenceDiagram"
    | "DatabaseLens"
    | "AnchorLink"
    | "CodePeek"
    | "TraceQuote",
  children: HydratedReviewNode[] = [],
): HydratedReviewNode => ({ type: "component", name, props: {}, children });

it("counts body evidence at any depth without treating a trace quote or the section title as a code reference", () => {
  expect(
    reviewSectionSummary([
      {
        type: "element",
        tag: "h2",
        props: {},
        children: [component("AnchorLink")],
      },
      p,
      component("SequenceDiagram"),
      component("DatabaseLens", [p, component("AnchorLink")]),
      component("CodePeek"),
      component("TraceQuote"),
    ]),
  ).toEqual({ diagrams: 2, codeRefs: 2, paragraphs: 2 });
});

it("includes the first body paragraph when the section has no heading", () => {
  expect(reviewSectionSummary([p, p])).toEqual({
    diagrams: 0,
    codeRefs: 0,
    paragraphs: 2,
  });
});
