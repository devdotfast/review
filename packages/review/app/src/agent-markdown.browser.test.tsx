import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownContent } from "./agent-markdown";

let container: HTMLDivElement, root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (source: string) => {
  await act(async () => root.render(<MarkdownContent source={source} />));
};

describe("MarkdownContent", () => {
  it("renders header cells with column alignment", async () => {
    await render("| Name | Qty |\n| --- | --: |\n| a | 2 |\n");

    const headers = container.querySelectorAll("th");
    expect(headers).toHaveLength(2);
    expect(getComputedStyle(headers[1]!).textAlign).toBe("right");
    expect(
      getComputedStyle(container.querySelectorAll("td")[1]!).textAlign,
    ).toBe("right");
  });

  it("renders GFM footnotes with references and definitions", async () => {
    await render("A note[^1].\n\n[^1]: Native pipeline footnote.\n");

    const reference = container.querySelector("a[data-footnote-ref]");
    expect(reference?.getAttribute("href")).toBe("#fn-1");
    expect(
      container.querySelector("section[data-footnotes] li#fn-1")?.textContent,
    ).toContain("Native pipeline footnote.");
  });
});
