import { act, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import type { Block } from "../../src/review-api/document";
import { ApiDocument } from "./api-document";
import {
  AuthoringActivityBadge,
  AuthoringActivityContext,
} from "./authoring-activity";
import type { AuthoringCursor } from "./authoring-cursor";
import { AuthoringCursorContext } from "./courier";
import { ReviewSessionProvider } from "./host/review-session";
import type { ReviewRoots } from "./review-root-context";
import { ReviewRootsProvider } from "./review-root-context";
import {
  testApiDocumentData,
  testReviewSession,
} from "./review-session-test-utils";

const blocks: Block[] = [
  { id: "b1", type: "markdown", markdown: "First paragraph, wide.\n" },
  {
    id: "b2",
    type: "section",
    title: "Folded",
    defaultCollapsed: true,
    children: [{ id: "b3", type: "markdown", markdown: "Hidden inside.\n" }],
  },
  { id: "b4", type: "markdown", markdown: "Last paragraph.\n" },
];

const data = testApiDocumentData(blocks);

const working = (description?: string): ActivitySnapshot => ({
  workingCount: 1,
  expiresAt: null,
  focuses: description ? [{ description }] : [],
});

const ended: ActivitySnapshot = { workingCount: 0, expiresAt: null };

let container: HTMLElement, article: HTMLElement, root: Root;

const onLocate = vi.fn<() => void>();

beforeEach(() => {
  article = document.createElement("article");
  article.className = "review-document";
  article.style.position = "relative";
  container = document.createElement("div");
  article.append(container);
  document.body.append(article);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  article.remove();
});

const render = async (
  activity: ActivitySnapshot | "unknown" | undefined,
  cursor: AuthoringCursor | null,
) => {
  const roots: ReviewRoots = {
    appRef: createRef<HTMLDivElement>(),
    shellRef: createRef<HTMLElement>(),
    scrollRegionRef: createRef<HTMLElement>(),
    articleRef: { current: article },
  };

  await act(async () =>
    root.render(
      <ReviewSessionProvider session={testReviewSession()}>
        <ReviewRootsProvider roots={roots}>
          <AuthoringActivityContext.Provider value={activity}>
            <AuthoringCursorContext.Provider value={cursor}>
              <AuthoringActivityBadge onLocate={onLocate} />
              <ApiDocument data={data} />
            </AuthoringCursorContext.Provider>
          </AuthoringActivityContext.Provider>
        </ReviewRootsProvider>
      </ReviewSessionProvider>,
    ),
  );
};

const at = (id: string, source: "edit" | "focus", seq: number) => ({
  targetId: id,
  blockId: id,
  source,
  seq,
});

const courier = () => article.querySelector<HTMLElement>(".courier");

const standsOn = (id: string) => {
  const target = article
    .querySelector(`[data-review-node-id="${id}"]`)!
    .getBoundingClientRect();

  const base = article.getBoundingClientRect();
  const figure = courier()!;
  expect(parseFloat(figure.style.top)).toBeCloseTo(target.top - base.top, 0);
  expect(parseFloat(figure.style.left)).toBeCloseTo(
    target.left - base.left + Math.min(target.width / 2, 96),
    0,
  );
};

it("stands on the cursor's block, hops when it moves, and stands in for a hidden block with its section", async () => {
  await render(working("Adding evidence"), at("b1", "focus", 1));
  await vi.waitFor(() => expect(courier()).toBeTruthy());
  standsOn("b1");
  expect(courier()!.dataset.state).toBe("live");
  expect(courier()!.dataset.motion).toBeUndefined();
  await vi.waitFor(() => expect(courier()!.dataset.idle).toBe("march"));
  expect(courier()!.querySelector(".courier-tag")?.textContent).toBe(
    "Adding evidence",
  );

  await render(working("Adding evidence"), {
    ...at("b4", "edit", 2),
    edit: { type: "insert", targetId: "b4", blockId: "b4", kind: "markdown" },
  });
  await vi.waitFor(() => standsOn("b4"));
  expect(courier()!.dataset.motion).toBe("hopping");
  expect(courier()!.dataset.idle).toBe("none");
  await vi.waitFor(() => expect(courier()!.dataset.motion).toBeUndefined());
  await vi.waitFor(() => expect(courier()!.dataset.idle).toBe("march"));

  // b3 is inside a collapsed section: he stands on the section instead.
  await render(working(), { ...at("b3", "edit", 3), blockId: "b2" });
  await vi.waitFor(() => standsOn("b2"));
});

it("jumps when clicked, goes grey when the stream drops, and leaves when the lease ends", async () => {
  await render(working(), at("b1", "focus", 1));
  await vi.waitFor(() => expect(courier()).toBeTruthy());

  await act(async () => {
    courier()!.querySelector("button")!.click();
  });
  await vi.waitFor(() => expect(courier()!.dataset.motion).toBe("jumping"));
  await vi.waitFor(() => expect(courier()!.dataset.motion).toBeUndefined());

  await render("unknown", at("b1", "focus", 1));
  expect(courier()!.dataset.state).toBe("unknown");

  await render(ended, at("b1", "focus", 1));
  await vi.waitFor(() => expect(courier()!.dataset.motion).toBe("leaving"));
  await vi.waitFor(() => expect(courier()).toBeNull());

  // A new lease brings him back onto the same cursor.
  await render(working(), at("b1", "focus", 1));
  await vi.waitFor(() => expect(courier()).toBeTruthy());
  standsOn("b1");
});

it("stays off the board while no activity is known and while viewing history", async () => {
  await render(undefined, at("b1", "focus", 1));
  expect(courier()).toBeNull();

  await render(working(), null);
  expect(courier()).toBeNull();
});

it("takes the reader to the courier from the top-bar badge, and he jumps", async () => {
  onLocate.mockClear();
  await render(working("Adding evidence"), at("b4", "focus", 1));
  await vi.waitFor(() => expect(courier()).toBeTruthy());

  const badge = article.querySelector<HTMLButtonElement>(
    "button.host-authoring-activity",
  )!;

  expect(badge).toBeTruthy();

  const target = article.querySelector<HTMLElement>(
    '[data-review-node-id="b4"]',
  )!;

  const scroll = vi.fn<() => void>();
  target.scrollIntoView = scroll;

  await act(async () => badge.click());
  expect(onLocate).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
  await vi.waitFor(() => expect(courier()!.dataset.motion).toBe("jumping"));

  // Without a courier to go to, the badge is only a status.
  await render(working(), null);
  expect(article.querySelector("button.host-authoring-activity")).toBeNull();
  expect(article.querySelector(".host-authoring-activity")).toBeTruthy();
});
