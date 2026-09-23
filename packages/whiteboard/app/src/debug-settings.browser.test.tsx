import {
  type WhiteboardSurfaceEvent,
  type WhiteboardTheme,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WhiteboardDebugSettingsProvider,
  useWhiteboardDebugSettings,
} from "./debug-settings";
import {
  type WhiteboardSession,
  WhiteboardSessionProvider,
} from "./host/whiteboard-session";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;

let theme = "dark" as WhiteboardTheme;

let themeListener: ((theme: WhiteboardTheme) => void) | undefined;

let surfaceListener: ((event: WhiteboardSurfaceEvent) => void) | undefined;

let session: WhiteboardSession;

beforeEach(() => {
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

describe("WhiteboardDebugSettingsProvider theme", () => {
  it("shows modified software-map nodes only by default", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <WhiteboardDebugSettingsProvider>
          <ThemeProbe />
        </WhiteboardDebugSettingsProvider>,
      );
    });

    expect(container.querySelector("[data-show-modified-only]")).not.toBeNull();
  });

  it("preserves an explicit preference to show every software-map node", async () => {
    window.localStorage.setItem(
      "progressive-review:debug-settings:theme-test",
      JSON.stringify({ showModifiedOnly: false }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <WhiteboardDebugSettingsProvider>
          <ThemeProbe />
        </WhiteboardDebugSettingsProvider>,
      );
    });

    expect(container.querySelector("[data-show-modified-only]")).toBeNull();
  });

  it.each(["light", "system"] as const)(
    "uses the dark host theme instead of a stored %s preference",
    async (storedTheme) => {
      window.localStorage.setItem(
        "progressive-review:debug-settings:theme-test",
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
          <WhiteboardDebugSettingsProvider>
            <ThemeProbe />
          </WhiteboardDebugSettingsProvider>,
        );
      });

      expect(
        container.querySelector(".whiteboard-app--theme-dark"),
      ).not.toBeNull();
      expect(
        container.querySelector("[data-show-modified-only]"),
      ).not.toBeNull();
      expect(container.querySelector("[data-show-removed-nodes]")).toBeNull();
      expect(
        container.querySelector("[data-node-tint='mineral']"),
      ).not.toBeNull();

      const persisted = parseJsonText(
        window.localStorage.getItem(
          "progressive-review:debug-settings:theme-test",
        ) ?? "{}",
      );

      if (!isJsonObject(persisted)) throw new Error("expected settings object");
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
        <WhiteboardDebugSettingsProvider>
          <ThemeProbe />
        </WhiteboardDebugSettingsProvider>,
      );
    });
    expect(
      container.querySelector(".whiteboard-app--theme-dark"),
    ).not.toBeNull();

    await act(async () => {
      theme = "light";
      themeListener?.(theme);
      surfaceListener?.({ event: "themeChanged", theme });
    });

    expect(
      container.querySelector(".whiteboard-app--theme-light"),
    ).not.toBeNull();
  });
});

function ThemeProbe() {
  const settings = useWhiteboardDebugSettings();

  return (
    <div
      className={`whiteboard-app--theme-${settings.theme}`}
      data-show-modified-only={settings.showModifiedOnly ? "true" : undefined}
      data-show-removed-nodes={settings.showRemovedNodes ? "true" : undefined}
      data-node-tint={settings.nodeTint}
    />
  );
}

function renderWithSession(node: ReactNode) {
  root!.render(
    <WhiteboardSessionProvider session={session}>
      {node}
    </WhiteboardSessionProvider>,
  );
}

function createTestSession(): WhiteboardSession {
  return testWhiteboardSession(
    {
      serverUrl: "http://127.0.0.1:4100",
      sessionId: "theme-test",
      token: "",
      theme,
    },
    {
      diffView: {
        files: async () => [],
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
      currentDiffLayout: () => "split",
      async setDiffLayout() {},
      onDidChangeDiffLayout: () => ({ dispose() {} }),
      ready() {},
    },
  );
}
