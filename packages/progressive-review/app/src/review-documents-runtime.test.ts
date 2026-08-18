import { describe, expect, it } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import { createSequence } from "./diagrams";
import { createActiveReviewDocument } from "./review-documents-runtime";

describe("review document anchor collection", () => {
  it("collects authored sequence code for real and generated anchors", () => {
    const realAnchor: AnchorRef = {
      __kind: "db-anchor-ref",
      id: "real-anchor",
      title: "Real anchor",
    };
    const sequence = createSequence({
      label: "Request flow",
      messages: [
        {
          from: { label: "Browser" },
          to: { label: "Worker" },
          label: "Request",
          anchor: realAnchor,
          code: { text: "fetch('/request')" },
        },
        {
          from: { label: "Worker" },
          to: { label: "Browser" },
          label: "Response",
          code: { text: "return response" },
        },
      ],
    });

    const document = createActiveReviewDocument({
      slug: "review",
      routePath: "/",
      filePath: "/repo/review.mdx",
      title: "Review",
      modelNames: ["sequence"],
      models: { sequence },
      Component: () => null,
      isDefault: true,
    });

    expect(document.anchors.get("real-anchor")).toBe(realAnchor);
    expect(document.anchorContents.get("real-anchor")).toBe(
      "fetch('/request')",
    );
    expect(document.anchorContents.get("sequence-request-flow-message-2")).toBe(
      "return response",
    );
  });
  it("creates a map-independent document", () => {
    const document = createActiveReviewDocument({
      slug: "review",
      routePath: "/",
      filePath: "/repo/review.mdx",
      title: "Review",
      modelNames: [],
      models: {},
      Component: () => null,
      isDefault: true,
    });

    expect(document.documentSoftwareModels).toEqual([]);
  });

  it("creates a map-free active document for a working-tree review", () => {
    const Component = () => null;
    const document = createActiveReviewDocument({
      slug: "working-tree",
      routePath: "/",
      filePath: "/tmp/review.mdx",
      title: "Working tree",
      modelNames: [],
      models: {},
      Component,
      isDefault: true,
    });

    expect(document.Component).toBe(Component);
  });
});
