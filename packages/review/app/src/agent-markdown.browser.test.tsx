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

const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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

  it("renders an image through the renderer the document supplies", async () => {
    await act(async () =>
      root.render(
        <MarkdownContent
          source={`![A shot](${PIXEL})\n`}
          renderImage={({ url, alt }) => (
            <figure className="review-image">
              <img src={url} alt={alt} loading="lazy" />
            </figure>
          )}
        />,
      ),
    );

    const image = container.querySelector("figure.review-image img");
    expect(image?.getAttribute("alt")).toBe("A shot");
    expect(image?.getAttribute("src")).toBe(PIXEL);
  });

  it("renders an image as its alt text when nothing renders it", async () => {
    await render(`![A shot](${PIXEL})\n`);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("em")?.textContent).toBe("A shot");
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
