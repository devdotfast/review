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

it("shares the version selected before login and keeps a manual copy fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let signedIn = false;
  let publishFails = true;
  const posts: Array<{ path: string; body: unknown }> = [];

  const client = new ReviewApiClient(
    { serverUrl: "http://localhost", token: "local" },
    async (url, init) => {
      const path = new URL(url).pathname;

      if (init?.method === "POST")
        posts.push({ path, body: JSON.parse(String(init.body)) });

      if (path.endsWith("/account"))
        return Response.json({
          account: signedIn
            ? { login: "author", origin: "https://app.dev.fast" }
            : null,
          pending: false,
        });

      if (path.endsWith("/login")) {
        signedIn = true;

        return Response.json({ pending: true });
      }

      if (path.endsWith("/publish") && publishFails)
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
    root.render(<Fixture version={version} />);

  await act(async () => render(4));
  await act(async () => container.querySelector("button")!.click());
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Sign in with GitHub")!
      .click(),
  );
  await act(async () => render(5));
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(container.textContent).toContain("Signed in as author");
    },
    { timeout: 4000 },
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Create share link")!
      .click(),
  );
  expect(
    posts.find((post) => post.path.endsWith("/publish"))?.body,
  ).toMatchObject({ reviewId: "authoring-review", version: 4 });
  expect(container.textContent).toContain("Review exceeds the sharing limit.");
  publishFails = false;
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Create share link")!
      .click(),
  );
  expect(container.querySelector("input")?.value).toContain("#capability");
  expect(container.textContent).toContain("Copy the link below.");
  let copied = "";
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      copied = document.querySelector("textarea")!.value;

      return true;
    },
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Copy link")!
      .click(),
  );
  expect(copied).toBe(container.querySelector("input")?.value);
  delete (document as Partial<Document>).execCommand;
});

it("keeps sender attribution and read-only details available from the shared-review icon", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const request = vi.fn<typeof fetch>();

  const client = new ReviewApiClient(
    { serverUrl: "http://localhost", token: "local" },
    request,
  );

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  dispose = () => root.unmount();

  function SharedReview() {
    const context = useMemo(
      () => ({
        client,
        reviewId: "shared-snapshot",
        version: 4,
        sender: "Alice",
      }),
      [client],
    );

    return (
      <SharingContext.Provider value={context}>
        <ShareControl />
      </SharingContext.Provider>
    );
  }

  await act(async () => root.render(<SharedReview />));

  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Shared by Alice"]',
  )!;

  await act(async () => trigger.click());

  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Shared by Alice");
  expect(dialog.textContent).toContain("This is a read-only snapshot.");
  expect(dialog.textContent).not.toContain("Create share link");
  expect(request).not.toHaveBeenCalled();
});
