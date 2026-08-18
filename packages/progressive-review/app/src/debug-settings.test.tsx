// @vitest-environment jsdom

import type {
  ReviewSurfaceEvent,
  ReviewTheme,
} from "@dev.fast/review-protocol";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ReviewDebugSettingsProvider,
  useReviewDebugSettings,
} from "./debug-settings";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;
let theme = "dark" as ReviewTheme;
let themeListener: ((theme: ReviewTheme) => void) | undefined;
let surfaceListener: ((event: ReviewSurfaceEvent) => void) | undefined;
let session: ReviewSession;

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  theme = "dark";
  session = createTestSession();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  themeListener = undefined;
  surfaceListener = undefined;
});

describe("ReviewDebugSettingsProvider theme", () => {
  it("shows modified software-map nodes only by default", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ThemeProbe />
        </ReviewDebugSettingsProvider>,
      );
    });

    expect(container.querySelector("[data-show-modified-only]")).not.toBeNull();
  });

  it("preserves an explicit preference to show every software-map node", async () => {
    window.localStorage.setItem(
      "progressive-review:debug-settings:theme-test:/review.mdx",
      JSON.stringify({ showModifiedOnly: false }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ThemeProbe />
        </ReviewDebugSettingsProvider>,
      );
    });

    expect(container.querySelector("[data-show-modified-only]")).toBeNull();
  });

  it.each(["light", "system"] as const)(
    "uses the dark host theme instead of a stored %s preference",
    async (storedTheme) => {
      window.localStorage.setItem(
        "progressive-review:debug-settings:theme-test:/review.mdx",
        JSON.stringify({
          settingsVersion: 2,
          theme: storedTheme,
          showModifiedOnly: true,
          showRemovedNodes: false,
          nodeTint: "mineral",
        }),
      );
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);

      await act(async () => {
        renderWithSession(
          <ReviewDebugSettingsProvider>
            <ThemeProbe />
          </ReviewDebugSettingsProvider>,
        );
      });

      expect(container.querySelector(".review-app--theme-dark")).not.toBeNull();
      expect(
        container.querySelector("[data-show-modified-only]"),
      ).not.toBeNull();
      expect(container.querySelector("[data-show-removed-nodes]")).toBeNull();
      expect(
        container.querySelector("[data-node-tint='mineral']"),
      ).not.toBeNull();

      const persisted = JSON.parse(
        window.localStorage.getItem(
          "progressive-review:debug-settings:theme-test:/review.mdx",
        ) ?? "{}",
      ) as Record<string, unknown>;
      expect(persisted.settingsVersion).toBe(3);
      expect(persisted).not.toHaveProperty("theme");
    },
  );

  it("follows live host theme changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDebugSettingsProvider>
          <ThemeProbe />
        </ReviewDebugSettingsProvider>,
      );
    });
    expect(container.querySelector(".review-app--theme-dark")).not.toBeNull();

    await act(async () => {
      theme = "light";
      themeListener?.(theme);
      surfaceListener?.({ event: "themeChanged", theme });
    });

    expect(container.querySelector(".review-app--theme-light")).not.toBeNull();
  });
});

function ThemeProbe() {
  const settings = useReviewDebugSettings();
  return (
    <div
      className={`review-app--theme-${settings.theme}`}
      data-show-modified-only={settings.showModifiedOnly ? "true" : undefined}
      data-show-removed-nodes={settings.showRemovedNodes ? "true" : undefined}
      data-node-tint={settings.nodeTint}
    />
  );
}

function renderWithSession(node: ReactNode) {
  root!.render(
    <ReviewSessionProvider session={session}>{node}</ReviewSessionProvider>,
  );
}

function createTestSession(): ReviewSession {
  return testReviewSession(
    {
      serverUrl: "http://127.0.0.1:4100",
      sessionUrl: "http://127.0.0.1:4101",
      routePath: "/review.mdx",
      sessionId: "theme-test",
      token: "",
      theme,
    },
    {
      diffView: {
        create: () => {
          throw new Error("unused test diff view");
        },
      },
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: () => {
          throw new Error("unused");
        },
      },
      post: async () => ({ ok: true }),
      subscribe: (listener) => {
        surfaceListener = listener;
        return { dispose: () => (surfaceListener = undefined) };
      },
      currentTheme: () => theme,
      onDidChangeTheme: (listener) => {
        themeListener = listener;
        return { dispose: () => (themeListener = undefined) };
      },
      ready() {},
    },
  );
}
