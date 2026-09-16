// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import type { Block } from "../../src/review-api/document";
import { ApiDocument, type ApiDocumentData } from "./api-document";
import { apiHeadingIds } from "./api-document-headings";
import {
  reviewSessionElement,
  testReviewSession,
} from "./review-session-test-utils";

const document: Block[] = [
  {
    id: "section",
    type: "section",
    title: "Architecture",
    children: [
      { id: "prose", type: "markdown", markdown: "Explanation" },
      { id: "map", type: "software_map", mapVersionId: "map-resource" },
    ],
  },
];

it("hides nested stored maps when disabled without dropping surrounding prose", () => {
  const data: ApiDocumentData = {
    snapshot: {
      reviewId: "review",
      version: 0,
      title: "Map",
      pins: { repositoryId: "repo", base: "base", head: "head" },
      createdAt: "today",
      document,
    },
    headings: apiHeadingIds(document),
    commits: [],
    anchors: new Map(),
    images: new Map(),
    traces: new Map(),
    maps: new Map(),
  };

  const render = (enabled: boolean) =>
    renderToStaticMarkup(
      reviewSessionElement(
        testReviewSession(),
        <ApiDocument data={data} softwareMapEnabled={enabled} />,
      ),
    );

  expect(render(false)).toContain("Explanation");
  expect(render(false)).not.toContain("software-map");
  expect(render(true)).toContain("software-map");
});
