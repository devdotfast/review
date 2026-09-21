// @vitest-environment jsdom
import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { ReviewApiClient } from "../../src/review-api/client";
import { ShareControl, SharingContext } from "./share-control";

let dispose: (() => void) | undefined;

afterEach(async () => {
  await act(async () => dispose?.());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Harness = ReturnType<typeof mount>;

function mount(options: {
  signedIn: boolean;
  publishFails?: boolean;
  publishExpired?: boolean;
  holdPublish?: Promise<void>;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state = { ...options };
  const posts: Array<{ path: string; body: unknown }> = [];
  let accountReads = 0;

  const client = new ReviewApiClient(
    { serverUrl: "http://localhost", token: "local" },
    async (url, init) => {
      const path = new URL(url).pathname;

      if (init?.method === "POST")
        posts.push({ path, body: JSON.parse(String(init.body)) });

      if (path.endsWith("/account")) {
        accountReads += 1;

        return Response.json({
          account: state.signedIn
            ? { login: "author", origin: "https://app.dev.fast" }
            : null,
          pending: false,
        });
      }

      if (path.endsWith("/login")) {
        state.signedIn = true;

        return Response.json({
          pending: true,
          url: "https://github.com/login/device",
        });
      }

      if (state.holdPublish) await state.holdPublish;

      if (path.endsWith("/publish") && state.publishExpired) {
        state.signedIn = false;
        state.publishExpired = false;

        return Response.json(
          { error: "Your sign-in has expired. Sign in again to share." },
          { status: 401 },
        );
      }

      if (path.endsWith("/publish") && state.publishFails)
        return Response.json(
          { error: "Review exceeds the sharing limit." },
          { status: 400 },
        );

      return Response.json({
        url: "https://app.dev.fast/s/snapshot#capability",
      });
    },
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  dispose = () => root.unmount();

  function Fixture({ version }: { version: number }) {
    const value = useMemo(
      () => ({ client, reviewId: "authoring-review", version }),
      [version],
    );

    return (
      <SharingContext.Provider value={value}>
        <ShareControl />
      </SharingContext.Provider>
    );
  }

  const render = (version: number) =>
    act(async () => root.render(<Fixture version={version} />));

  const click = (text: string) =>
    act(async () =>
      [...container.querySelectorAll("button")]
        .find(
          (button) =>
            button.textContent === text ||
            button.getAttribute("aria-label") === text,
        )!
        .click(),
    );

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

  return {
    container,
    posts,
    state,
    render,
    click,
    settle,
    accountReads: () => accountReads,
  };
}

const publishes = (harness: Harness) =>
  harness.posts.filter((post) => post.path.endsWith("/publish"));

it("asks a signed-out user to sign in, then uploads the version chosen before login", async () => {
  const harness = mount({ signedIn: false });
  const { container } = harness;

  await harness.render(4);
  await harness.click("Share review");
  await harness.settle();
  expect(
    [...container.querySelectorAll("[role=dialog] button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Sign in to share"]);
  expect(publishes(harness)).toHaveLength(0);
  await harness.click("Sign in to share");
  expect(container.textContent).toContain("Waiting for GitHub…");
  expect(container.querySelector("[role=dialog] a")).toBeNull();
  await harness.render(5);
  await vi.waitFor(
    async () => {
      await harness.settle();
      expect(container.querySelector("input")?.value).toContain("#capability");
    },
    { timeout: 4000 },
  );
  expect(publishes(harness).map((post) => post.body)).toEqual([
    expect.objectContaining({ reviewId: "authoring-review", version: 4 }),
  ]);
  expect(container.textContent).not.toContain("Sign in");
});

it("uploads on open for a signed-in user, retries after a failure, and copies the link", async () => {
  const harness = mount({ signedIn: true, publishFails: true });
  const { container } = harness;

  await harness.render(4);
  await harness.click("Share review");
  await harness.settle();
  expect(publishes(harness)).toHaveLength(1);
  expect(container.textContent).toContain("Review exceeds the sharing limit.");
  expect(container.textContent).not.toContain("Create share link");
  harness.state.publishFails = false;
  await harness.click("Retry");
  await harness.settle();
  expect(publishes(harness)).toHaveLength(2);
  expect(container.querySelector("input")?.value).toContain("#capability");
  expect(container.textContent).not.toContain("Uploading");
  let copied = "";
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      copied = document.querySelector("textarea")!.value;

      return true;
    },
  });
  await harness.click("Copy link");
  expect(copied).toBe(container.querySelector("input")?.value);
  expect(container.textContent).toContain("Copied");
  delete (document as Partial<Document>).execCommand;
});

it("shows the uploading state until the upload resolves", async () => {
  let release: (() => void) | undefined;

  const harness = mount({
    signedIn: true,
    holdPublish: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });

  const { container } = harness;

  await harness.render(1);
  await harness.click("Share review");
  await harness.settle();
  expect(container.textContent).toContain("Uploading…");
  expect(container.querySelector("input")).toBeNull();
  release?.();
  await harness.settle();
  expect(container.querySelector("input")?.value).toContain("#capability");
  expect(container.textContent).not.toContain("Uploading");
});

it("knows the sign-in state before the popover opens and refreshes it on focus", async () => {
  const harness = mount({ signedIn: true });
  const { container } = harness;

  await harness.render(1);
  await harness.settle();
  expect(harness.accountReads()).toBe(1);
  await harness.click("Share review");
  expect(publishes(harness)).toHaveLength(1);
  await harness.settle();
  await harness.click("Share review");
  await harness.click("Share review");
  expect(harness.accountReads()).toBe(1);
  expect(container.querySelector("input")?.value).toContain("#capability");
  await act(async () => window.dispatchEvent(new Event("focus")));
  await harness.settle();
  expect(harness.accountReads()).toBe(2);
});

it("falls back to sign-in when the stored login has expired, then uploads after re-login", async () => {
  const harness = mount({ signedIn: true, publishExpired: true });
  const { container } = harness;

  await harness.render(4);
  await harness.settle();
  await harness.click("Share review");
  await harness.settle();
  expect(publishes(harness)).toHaveLength(1);
  expect(container.textContent).toContain("Your sign-in has expired.");
  expect(
    [...container.querySelectorAll("[role=dialog] button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Sign in to share"]);
  await harness.click("Sign in to share");
  await vi.waitFor(
    async () => {
      await harness.settle();
      expect(container.querySelector("input")?.value).toContain("#capability");
    },
    { timeout: 4000 },
  );
  expect(publishes(harness)).toHaveLength(2);
  expect(container.textContent).not.toContain("expired");
});

it("reuses the link for a version that was already shared and uploads again for a new one", async () => {
  const harness = mount({ signedIn: true });
  const { container } = harness;

  await harness.render(4);
  await harness.settle();
  await harness.click("Share review");
  await harness.settle();
  expect(publishes(harness)).toHaveLength(1);
  expect(container.querySelector("input")?.value).toContain("#capability");
  await harness.click("Share review");
  await harness.click("Share review");
  expect(container.textContent).not.toContain("Uploading");
  expect(container.querySelector("input")?.value).toContain("#capability");
  await harness.settle();
  expect(publishes(harness)).toHaveLength(1);
  await harness.click("Share review");
  await harness.render(5);
  await harness.click("Share review");
  await harness.settle();
  expect(publishes(harness).map((post) => post.body)).toEqual([
    expect.objectContaining({ version: 4 }),
    expect.objectContaining({ version: 5 }),
  ]);
});
