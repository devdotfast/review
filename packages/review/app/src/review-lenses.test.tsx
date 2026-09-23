// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import { SessionApiClient } from "../../src/review-api/client";
import type { Snapshot } from "../../src/review-api/store";
import { ReviewDiffView } from "./DiffView";
import { ReviewSessionProvider } from "./host/review-session";
import { ReviewLensesProvider } from "./review-lenses";
import { testReviewSession } from "./review-session-test-utils";

it("clears a lens without destroying the full comparison's native state", async () => {
  const disposed: string[] = [];

  const session = testReviewSession(
    {},
    {
      request: async () =>
        Response.json({
          files: [],
          lenses: [
            {
              id: "diagram",
              title: "Path",
              sources: [{ side: "head", file: "a.ts", fromLine: 1, toLine: 8 }],
            },
          ],
        }),
      diffView: {
        files: async () => [],
        create(spec) {
          const id = spec.lens?.id ?? "full";
          spec.container.textContent = `native ${id}`;

          return {
            focus() {},
            onDidError: () => ({ dispose() {} }),
            dispose() {
              disposed.push(id);
            },
          };
        },
      },
    },
  );

  const client = new SessionApiClient(session.config, session.bridge.request);

  const snapshot: Snapshot = {
    sessionId: "test-session",
    version: 0,
    title: "Test",
    target: {
      kind: "commits" as const,
      ...{ repositoryId: "r", base: "b", head: "h" },
    },
    pins: { repositoryId: "r", base: "b", head: "h" },
    document: [],
    createdAt: "2026-09-17",
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <ReviewSessionProvider session={session}>
          <ReviewLensesProvider client={client} snapshot={snapshot}>
            <ReviewDiffView />
          </ReviewLensesProvider>
        </ReviewSessionProvider>,
      ),
    );

    const full = container.querySelector<HTMLElement>(
      ".review-diff-view-host",
    )!;

    await act(async () => {
      const button = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Path"),
      )!;

      button.click();
    });
    expect(full.style.display).toBe("none");

    const selectedToggle = container.querySelector(".diff-lens-toggle");
    expect(selectedToggle?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".review-diff-view-host")).toHaveLength(
      2,
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-pressed="true"]')!
        .click();
    });
    expect(container.querySelector(".review-diff-view-host")).toBe(full);
    expect(full.style.display).toBe("");
    expect(disposed).toEqual(["diagram"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
