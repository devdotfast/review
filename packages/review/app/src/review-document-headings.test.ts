import { describe, expect, it } from "vitest";

import {
  assignReviewHeadingIds,
  reviewTocEntries,
} from "./review-document-headings";
import type { HydratedReviewNode } from "./review-document-hydrate";

const heading = (text: string, id?: string | number): HydratedReviewNode => ({
  type: "element",
  tag: "h2",
  props: id === undefined ? {} : { id },
  children: [{ type: "text", value: text }],
});

describe("document heading navigation", () => {
  it("preserves authored IDs and reserves their trimmed values before assigning unique slugs", () => {
    const body = [
      heading("Data flow"),
      heading("Data flow"),
      heading("Authored", " data-flow "),
      heading("Numeric", 0),
      heading("Whitespace", "  "),
      heading("!!!"),
      heading("???"),
      heading(""),
    ];

    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body).map(({ id }) => id)).toEqual([
      "data-flow-2",
      "data-flow-3",
      " data-flow ",
      "0",
      "  ",
      "section",
      "section-2",
    ]);
    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body).map(({ id }) => id)).toEqual([
      "data-flow-2",
      "data-flow-3",
      " data-flow ",
      "0",
      "  ",
      "section",
      "section-2",
    ]);
  });

  it("flattens inline markup and whitespace in document order", () => {
    const body: HydratedReviewNode[] = [
      {
        type: "element",
        tag: "h3",
        props: {},
        children: [
          { type: "text", value: "The  " },
          {
            type: "element",
            tag: "em",
            props: {},
            children: [{ type: "text", value: "hot" }],
          },
          { type: "text", value: "\npath" },
        ],
      },
    ];

    assignReviewHeadingIds(body);
    expect(reviewTocEntries(body)).toEqual([
      { id: "the-hot-path", text: "The hot path", level: "h3" },
    ]);
  });
});
