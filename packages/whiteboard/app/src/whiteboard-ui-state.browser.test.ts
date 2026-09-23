import { afterEach, describe, expect, it } from "vitest";

import { TEST_WHITEBOARD_CONFIG } from "./whiteboard-session-test-utils";
import {
  forgetWhiteboardUiState,
  readWhiteboardUiState,
  removeWhiteboardUiState,
  whiteboardUiStateKey,
  writeWhiteboardUiState,
} from "./whiteboard-ui-state";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("review UI state", () => {
  it("round-trips a value in each scope", () => {
    writeWhiteboardUiState("reader", "width", 720);
    writeWhiteboardUiState("session", "collapsed", true);
    writeWhiteboardUiState("window", "cache", { hit: 1 });

    expect(readWhiteboardUiState<number>("reader", "width")).toBe(720);
    expect(readWhiteboardUiState<boolean>("session", "collapsed")).toBe(true);
    expect(readWhiteboardUiState<{ hit: number }>("window", "cache")).toEqual({
      hit: 1,
    });
  });

  it("keeps window scope out of localStorage so it dies with the window", () => {
    writeWhiteboardUiState("window", "cache", 1);
    expect(window.sessionStorage.getItem("cache")).toBe("1");
    expect(window.localStorage.getItem("cache")).toBeNull();

    writeWhiteboardUiState("session", "kept", 1);
    expect(window.localStorage.getItem("kept")).toBe("1");
    expect(window.sessionStorage.getItem("kept")).toBeNull();
  });

  it("falls back to null for missing and unreadable entries", () => {
    window.localStorage.setItem("broken", "{");
    window.localStorage.setItem("empty", "");
    // A value written by an older, non-JSON format must not throw.
    window.localStorage.setItem("legacy", "collapsed");

    expect(readWhiteboardUiState("reader", "absent")).toBeNull();
    expect(readWhiteboardUiState("reader", "broken")).toBeNull();
    expect(readWhiteboardUiState("reader", "empty")).toBeNull();
    expect(readWhiteboardUiState("reader", "legacy")).toBeNull();
  });

  it("removes single entries and whole key families", () => {
    writeWhiteboardUiState("window", "nav:a", 1);
    writeWhiteboardUiState("window", "nav:b", 2);
    writeWhiteboardUiState("window", "other", 3);

    removeWhiteboardUiState("window", "nav:a");
    expect(readWhiteboardUiState("window", "nav:a")).toBeNull();

    forgetWhiteboardUiState("window", (key) => key.startsWith("nav:"));
    expect(readWhiteboardUiState("window", "nav:b")).toBeNull();
    expect(readWhiteboardUiState("window", "other")).toBe(3);
  });

  it("keys reader scope without the session so it outlives one review", () => {
    const reader = whiteboardUiStateKey(
      null,
      "reader",
      "ui",
      "side-peek-width",
    );

    const session = whiteboardUiStateKey(
      TEST_WHITEBOARD_CONFIG,
      "session",
      "section",
      "Testing",
    );

    expect(reader).toBe("progressive-review:ui:side-peek-width");
    expect(session).toContain("progressive-review:section:");
    expect(session).not.toBe("progressive-review:section:Testing");
  });
});
