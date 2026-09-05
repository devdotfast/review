import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentMarkdown } from "./agent-markdown";

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

  it("renders reference-style links as clickable anchors", () => {
    const full = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[see docs][1]\n\n[1]: https://example.com/docs",
      }),
    );
    expect(full).toContain('href="https://example.com/docs"');
    expect(full).toContain('target="_blank"');
    expect(full).toContain('rel="noopener noreferrer"');
    expect(full).toContain(">see docs</a>");

    const collapsed = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[see docs]\n\n[see docs]: https://example.com/collapsed",
      }),
    );
    expect(collapsed).toContain('href="https://example.com/collapsed"');
    expect(collapsed).toContain(">see docs</a>");

    const shortcut = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[docs]\n\n[docs]: https://example.com/shortcut",
      }),
    );
    expect(shortcut).toContain('href="https://example.com/shortcut"');
    expect(shortcut).toContain(">docs</a>");
  });

  it("renders image references as italicized alt text like inline images", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "![alt text][img]\n\n[img]: https://example.com/x.png",
      }),
    );
    expect(html).toContain("<em>alt text</em>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com/x.png");
  });

  it("renders local filesystem reference links as non-clickable code references", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: [
          "[App.test.ts:49][1]",
          "",
          "[1]: /Users/ketanagrawal/monorepo/App.test.ts:49",
          "",
          "[styles][2]",
          "",
          "[2]: file:///Users/k/styles.css",
        ].join("\n"),
      }),
    );

    expect(html).not.toContain("href=");
    expect(html).not.toContain("file://");
    expect(html).not.toContain("/Users/k");
    expect(html).toContain(
      '<code class="agent-markdown-code-reference">App.test.ts:49</code>',
    );
    expect(html).toContain(
      '<code class="agent-markdown-code-reference">styles</code>',
    );
  });

  it("does not emit unsafe reference link URLs as href", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[evil][1]\n\n[1]: javascript:alert(1)",
      }),
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
    expect(html).toContain("evil");
  });

  it("renders unresolved references as literal text without an href", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[nope][missing]\n\n[other]: https://example.com/other",
      }),
    );

    expect(html).toContain("[nope][missing]");
    expect(html).not.toContain("href=");
  });

  it("resolves reference links nested inside block quotes", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "> [see docs][1]\n>\n> [1]: https://example.com/bq",
      }),
    );
    expect(html).toContain('href="https://example.com/bq"');
    expect(html).toContain(">see docs</a>");
  });

  it("resolves reference links inside table cells", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source:
          "| col |\n| --- |\n| [link][1] |\n\n[1]: https://example.com/table",
      }),
    );
    expect(html).toContain('href="https://example.com/table"');
    expect(html).toContain(">link</a>");
  });

  it("highlights quote spans inside reference link labels", () => {
    const html = renderToStaticMarkup(
      createElement(AgentMarkdown, {
        source: "[see docs][1]\n\n[1]: https://example.com/docs",
        highlightQuote: "see docs",
      }),
    );
    expect(html).toContain(
      '<mark class="review-trace-quote-mark">see docs</mark>',
    );
    expect(html).toContain('href="https://example.com/docs"');
  });
});
