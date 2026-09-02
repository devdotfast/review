import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentMarkdown, MarkdownContent } from "./agent-markdown";

describe("agent markdown", () => {
  it("renders agent answers as GitHub-flavored markdown", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: [
          "**Done**",
          "",
          "- one",
          "- two",
          "",
          "| file | status |",
          "| --- | --- |",
          "| `App.tsx` | fixed |",
          "",
          "```ts",
          "const answer = true;",
          "```",
          "",
          "[Docs](https://example.com/docs)",
        ].join("\n"),
      }),
    );

    expect(html).toContain("<strong>Done</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li><p>one</p></li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>App.tsx</code>");
    expect(html).toContain(
      'class="rendered-code-block markdown-code-block" data-language="ts"',
    );
    expect(html).toContain("const answer = true;");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not execute raw html or unsafe markdown links", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source:
          '<script>alert("x")</script>\n\n[run this](javascript:alert("x"))',
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("run this");
  });

  it("renders local filesystem links as non-clickable code references", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: [
          "[App.test.ts:49](/Users/ketanagrawal/monorepo/repos/dev/packages/progressive-review/app/src/App.test.ts:49)",
          "[styles.css](file:///Users/ketanagrawal/monorepo/repos/dev/packages/progressive-review/app/src/styles.css)",
        ].join("\n\n"),
      }),
    );

    expect(html).not.toContain("href=");
    expect(html).not.toContain("file://");
    expect(html).not.toContain("/Users/ketanagrawal");
    expect(html).toContain(
      '<code class="agent-markdown-code-reference">App.test.ts:49</code>',
    );
    expect(html).toContain(
      '<code class="agent-markdown-code-reference">styles.css</code>',
    );
  });

  it("highlights quote spans inside markdown paragraphs and inline code", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "We should optimize database queries to avoid latency.",
        highlightQuote: "optimize database queries",
      }),
    );

    expect(html).toContain(
      '<mark class="review-trace-quote-mark">optimize database queries</mark>',
    );
  });

  it("decodes named character references without using DOM innerHTML", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "a &amp; b &gt; c",
      }),
    );

    expect(html).toContain("a &amp; b &gt; c");
  });

  it("lets a trusted document replace reserved links with interactive content", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownContent, {
        source: "Open [the source](#review-inline-link-1) here.",
        renderLink: ({ href, children }) =>
          href === "#review-inline-link-1"
            ? createElement("button", { type: "button" }, children)
            : undefined,
      }),
    );

    expect(html).toContain('<button type="button">the source</button>');
    expect(html).not.toContain("review-inline-link-1");
  });
});
