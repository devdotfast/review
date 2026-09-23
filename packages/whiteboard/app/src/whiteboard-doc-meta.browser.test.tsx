import type { WhiteboardCanvasBridge } from "@dev.fast/whiteboard-protocol";
import { act } from "react";
import { type Root, createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisplayedWhiteboardVersionContext } from "./displayed-whiteboard-version-context";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import { WhiteboardDocumentMetaLine } from "./whiteboard-doc-meta";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

let root: Root | null = null;

describe("WhiteboardDocumentMetaLine", () => {
  beforeEach(() => {});

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }

    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("uses the displayed snapshot's branch and hides it when unavailable", async () => {
    const session = testWhiteboardSession();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const render = async (headBranch: string | undefined, version: number) => {
      session.review = { ...session.review!, headBranch };
      await act(async () =>
        root?.render(
          <WhiteboardSessionProvider session={session}>
            <DisplayedWhiteboardVersionContext.Provider value={version}>
              <WhiteboardDocumentMetaLine />
            </DisplayedWhiteboardVersionContext.Provider>
          </WhiteboardSessionProvider>,
        ),
      );
    };

    await render("codex/reorganize-homepage-sections", 2);
    expect(container.textContent).toContain(
      "codex/reorganize-homepage-sections",
    );
    await render("feature/earlier-name", 1);
    expect(container.textContent).toContain("feature/earlier-name");
    expect(container.textContent).not.toContain(
      "codex/reorganize-homepage-sections",
    );
    await render(undefined, 0);
    expect(container.querySelector(".whiteboard-doc-meta-branch")).toBeNull();
  });

  it("hydrates when the relative update time changes after SSR", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(Date.UTC(2026, 6, 22, 12, 1));

    const session = testWhiteboardSession();
    session.review!.updatedAtMs = Date.UTC(2026, 6, 22, 12, 0);

    const tree = (
      <WhiteboardSessionProvider session={session}>
        <WhiteboardDocumentMetaLine />
      </WhiteboardSessionProvider>
    );

    const serverHtml = renderToString(tree);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    now.mockReturnValue(Date.UTC(2026, 6, 22, 12, 5));

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await act(async () => {
      root = hydrateRoot(container, tree);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      consoleError.mock.calls.map((call) => call.map(String).join(" ")),
    ).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Hydration failed")]),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Updated 5 min ago"),
    );
  });

  it("refreshes PR identity and update time as the displayed version changes without remounting", async () => {
    const now = Date.UTC(2026, 6, 22, 12, 10);
    vi.spyOn(Date, "now").mockReturnValue(now);

    let meta = {
      ok: true,
      updatedAtMs: now - 300_000,
      pullRequestNumber: null as number | null,
      pullRequestUrl: null as string | null,
    };

    const session = testWhiteboardSession();

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const render = async (version: number) => {
      session.review = {
        ...session.review!,
        updatedAtMs: meta.updatedAtMs,
        pullRequestNumber: meta.pullRequestNumber ?? undefined,
        pullRequestUrl: meta.pullRequestUrl ?? undefined,
      };

      await act(async () => {
        root?.render(
          <WhiteboardSessionProvider session={session}>
            <DisplayedWhiteboardVersionContext.Provider value={version}>
              <WhiteboardDocumentMetaLine />
            </DisplayedWhiteboardVersionContext.Provider>
          </WhiteboardSessionProvider>,
        );
      });
    };

    await render(0);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Updated 5 min ago"),
    );
    expect(container.querySelector("a")).toBeNull();
    meta = {
      ok: true,
      updatedAtMs: now,
      pullRequestNumber: 310,
      pullRequestUrl: "https://github.com/devdotfast/review/pull/310",
    };
    await render(1);
    await vi.waitFor(() =>
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        meta.pullRequestUrl,
      ),
    );
    expect(container.textContent).toContain("PR #310");
    expect(container.textContent).toContain("Updated just now");
    meta = {
      ok: true,
      updatedAtMs: now,
      pullRequestNumber: null,
      pullRequestUrl: null,
    };
    await render(2);
    await vi.waitFor(() => expect(container.querySelector("a")).toBeNull());
  });

  it("opens an available later Review in a background tab", async () => {
    const post = vi.fn<WhiteboardCanvasBridge["post"]>(async () => ({
      ok: true,
    }));

    const stackSession = testWhiteboardSession({}, { post });
    stackSession.review!.pullRequestNumber = 20;
    stackSession.review!.stack = async () => [
      {
        branch: "feature-b",
        relation: "current",
        pullRequestNumber: 20,
        pullRequestUrl: "https://github.com/o/r/pull/20",
        sessionId: "22222222-2222-4222-8222-222222222222",
        whiteboardTitle: "Review B",
      },
      {
        branch: "feature-c",
        relation: "later",
        pullRequestNumber: 30,
        pullRequestUrl: "https://github.com/o/r/pull/30",
        sessionId: "11111111-1111-4111-8111-111111111111",
        whiteboardTitle: "Review C",
      },
      {
        branch: "feature-d",
        relation: "later",
        pullRequestNumber: 40,
        pullRequestUrl: "https://github.com/o/r/pull/40",
        sessionId: null,
        whiteboardTitle: null,
      },
    ];

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WhiteboardSessionProvider session={stackSession}>
          <WhiteboardDocumentMetaLine />
        </WhiteboardSessionProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("1 of 3");
    });
    expect(container.textContent).toContain("current");
    expect(
      [...container.querySelectorAll(".whiteboard-stack-position-marker")].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["1", "2", "3"]);

    const unavailable = container.querySelector<HTMLButtonElement>(
      ".whiteboard-stack-menu button:disabled",
    );

    expect(unavailable?.textContent).toContain("PR #40");

    const layer = container.querySelector<HTMLButtonElement>(
      '.whiteboard-stack-menu button[data-relation="later"]',
    );

    expect(layer?.textContent).toContain("PR #30");
    await act(async () => {
      layer?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, metaKey: true }),
      );
    });
    expect(post).toHaveBeenCalledWith({
      name: "openWhiteboard",
      args: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        active: false,
      },
    });
    await act(async () => {
      unavailable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
