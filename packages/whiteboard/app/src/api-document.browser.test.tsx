import { act, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SessionApiClient } from "../../src/session-api/client";
import type { Block } from "../../src/session-api/document";
import { ApiDocument, createDocumentLoader } from "./api-document";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import type { WhiteboardRoots } from "./whiteboard-root-context";
import { WhiteboardRootsProvider } from "./whiteboard-root-context";
import {
  testApiDocumentData,
  testWhiteboardSession,
} from "./whiteboard-session-test-utils";

const blocks: Block[] = [
  {
    id: "b1",
    type: "markdown",
    markdown:
      "## Summary\n\n### Details\n\nSee [the nested notes](#details-2) or [what left](#gone).\n",
  },
  {
    id: "b2",
    type: "section",
    title: "Implementation",
    defaultCollapsed: true,
    children: [
      { id: "b3", type: "markdown", markdown: "## Details\n\nNested text\n" },
    ],
  },
];

const data = testApiDocumentData(blocks);

let container: HTMLElement, article: HTMLElement, root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  article = document.createElement("article");
  article.className = "whiteboard-document";
  container = document.createElement("div");
  article.append(container);
  document.body.append(article);
});

afterEach(async () => {
  await act(async () => root.unmount());
  article.remove();
});

const render = async (shown = data) => {
  const roots: WhiteboardRoots = {
    appRef: createRef<HTMLDivElement>(),
    shellRef: createRef<HTMLElement>(),
    scrollRegionRef: createRef<HTMLElement>(),
    articleRef: { current: article },
  };

  root = createRoot(container);
  await act(async () =>
    root.render(
      <WhiteboardSessionProvider session={testWhiteboardSession()}>
        <WhiteboardRootsProvider roots={roots}>
          <ApiDocument data={shown} />
        </WhiteboardRootsProvider>
      </WhiteboardSessionProvider>,
    ),
  );
};

it("expands a collapsed section and scrolls when a fragment link is followed", async () => {
  await render();

  const body = article.querySelector<HTMLElement>(".whiteboard-section-body")!;
  expect(body.hidden).toBe(true);

  // The nested "Details" repeats the loose one, so its slug is `details-2`.
  const target = article.querySelector<HTMLElement>("#details-2")!;
  const scroll = vi.fn<() => void>();
  target.scrollIntoView = scroll;

  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () =>
    article.querySelector('a[href="#details-2"]')!.dispatchEvent(click),
  );

  // The anchor navigates the document itself, so the browser must not.
  expect(click.defaultPrevented).toBe(true);
  expect(body.hidden).toBe(false);
  await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
});

it("leaves a fragment that names no heading to the browser", async () => {
  await render();

  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  article.querySelector('a[href="#gone"]')!.dispatchEvent(click);

  expect(click.defaultPrevented).toBe(false);
});

it("renders the retained document without reading commits when the source is gone", async () => {
  const request = vi.fn<() => Promise<Response>>(async () =>
    Response.json([{ commit: "c", subject: "Never read" }]),
  );

  const loader = createDocumentLoader(
    new SessionApiClient(
      { serverUrl: "http://review.invalid", token: "t" },
      request,
    ),
  );

  const degraded = await loader.load({
    ...data.snapshot,
    sourceUnavailable: true,
  });

  expect(request).not.toHaveBeenCalled();
  expect(degraded.commits).toEqual([]);
  await render(degraded);

  expect(article.textContent).toContain("Imported");
  expect(article.querySelector("#details-2")).not.toBeNull();
  expect(article.querySelector(".whiteboard-source-context")?.textContent).toBe(
    "Local checkout unavailable. Showing retained source.",
  );
});
