import { Children, type ReactNode, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { reviewAuthoringComponents } from "./review-authoring-components";
import type { HydratedReviewNode } from "./review-document-hydrate";
import { renderReviewNodes } from "./review-document-renderer";
import { reviewDocumentComponents } from "./review-document-surface";

describe("renderReviewNodes", () => {
  it.each(["left", "center", "right"])(
    "renders table alignment %s above the document CSS default",
    (align) => {
      for (const tag of ["th", "td"] as const) {
        const nodes: HydratedReviewNode[] = [
          {
            type: "element",
            tag,
            props: { align },
            children: [{ type: "text", value: "Cell" }],
          },
        ];

        const html = renderToStaticMarkup(
          renderReviewNodes(nodes, reviewDocumentComponents),
        );

        expect(html).toContain(`style="text-align:${align}"`);
        expect(nodes[0]).toMatchObject({ props: { align } });
        expect(JSON.stringify(nodes)).not.toContain("style");
      }
    },
  );

  it("passes prose props through the registry overrides", () => {
    const nodes: HydratedReviewNode[] = [
      {
        type: "element",
        tag: "a",
        props: {
          href: "https://example.com/docs",
          "aria-label": "Documentation",
        },
        children: [{ type: "text", value: "Docs" }],
      },
    ];

    const html = renderToStaticMarkup(
      renderReviewNodes(nodes, reviewDocumentComponents),
    );

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('aria-label="Documentation"');
    expect(html).toContain('target="_blank"');
  });

  it("routes pre > code prose through MarkdownCodeBlock", () => {
    const nodes: HydratedReviewNode[] = [
      {
        type: "element",
        tag: "pre",
        props: {},
        children: [
          {
            type: "element",
            tag: "code",
            props: { className: "language-ts" },
            children: [{ type: "text", value: "const answer = 42;" }],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      renderReviewNodes(nodes, reviewDocumentComponents),
    );

    expect(html).toContain("markdown-code-block");
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("const answer = 42;");
  });

  it("preserves ReviewSection and DatabaseLens component identity", () => {
    const nodes: HydratedReviewNode[] = [
      {
        type: "component",
        name: "ReviewSection",
        props: { title: "Data" },
        children: [
          {
            type: "element",
            tag: "h2",
            props: {},
            children: [{ type: "text", value: "Data" }],
          },
        ],
      },
      {
        type: "component",
        name: "DatabaseLens",
        props: { id: "db:data", actors: {}, stores: {}, useCases: [] },
        children: [],
      },
    ];

    const rendered = renderReviewNodes(nodes, reviewDocumentComponents);
    expect(isValidElement(rendered)).toBe(true);

    if (!isValidElement<{ children: unknown }>(rendered)) return;

    const [section, lens] = Children.toArray(
      rendered.props.children as ReactNode,
    );

    expect(isValidElement(section) && section.type).toBe(
      reviewAuthoringComponents.ReviewSection,
    );
    expect(isValidElement(lens) && lens.type).toBe(
      reviewAuthoringComponents.DatabaseLens,
    );

    if (!isValidElement<{ children: unknown }>(section)) return;

    if (!isValidElement<{ children: unknown }>(lens)) return;

    const sectionHeading = Children.toArray(
      section.props.children as ReactNode,
    )[0];

    expect(isValidElement(sectionHeading) ? sectionHeading.type : null).toBe(
      "h2",
    );
  });
});
