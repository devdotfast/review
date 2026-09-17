// @vitest-environment jsdom
import { ReviewApiClient } from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { RepositorySetup, ReviewProjectSetup } from "./project-setup";

let root: Root;

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows setup failure without blocking review content and lets the user retry", async () => {
  let state = "failed";

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "token" },
    async (url, init) => {
      if (init?.method === "POST") {
        state = "ready";

        return Response.json({ ok: true });
      }

      return Response.json([
        {
          id: "workspace",
          commit: "123456789",
          state,
          log: state === "failed" ? "Dependency installation failed" : "",
          directory: "/workspace",
        },
      ]);
    },
  );

  await act(async () =>
    root.render(
      <>
        <p>Review content</p>
        <ReviewProjectSetup
          client={client}
          reviewId="review"
          version={1}
          repositoryId="repository"
        />
      </>,
    ),
  );
  expect(container.textContent).toContain("Review content");
  expect(container.textContent).toContain("setup failed");
  expect(container.textContent).toContain("Dependency installation failed");

  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;

  await act(async () => retry.click());
  expect(container.textContent).toContain("ready");
  expect(container.textContent).not.toContain("Dependency installation failed");
});

it("saving configuration leaves environments unchanged until explicit rebuilding", async () => {
  let rebuilt = false;
  let saved = false;

  const client = new ReviewApiClient(
    { serverUrl: "http://review", token: "token" },
    async (url, init) => {
      if (url.endsWith("/rebuild")) rebuilt = true;
      else if (init?.method === "POST") saved = true;

      return Response.json({ setup: "pnpm install", teardown: "" });
    },
  );

  await act(async () =>
    root.render(<RepositorySetup client={client} repositoryId="repository" />),
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Save")!
      .click(),
  );
  expect(saved).toBe(true);
  expect(rebuilt).toBe(false);
  expect(container.textContent).toContain(
    "Existing environments are unchanged",
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Save and rebuild environments")!
      .click(),
  );
  expect(rebuilt).toBe(true);
  expect(container.textContent).toContain("Rebuilding project environments");
});
