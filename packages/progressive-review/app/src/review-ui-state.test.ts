// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_REVIEW_CONFIG } from "./review-session-test-utils";
import {
  forgetReviewUiState,
  readReviewUiState,
  removeReviewUiState,
  reviewUiStateKey,
  writeReviewUiState,
} from "./review-ui-state";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("review UI state", () => {
  it("round-trips a value in each scope", () => {
    writeReviewUiState("reader", "width", 720);
    writeReviewUiState("session", "collapsed", true);
    writeReviewUiState("window", "cache", { hit: 1 });

    expect(readReviewUiState<number>("reader", "width")).toBe(720);
    expect(readReviewUiState<boolean>("session", "collapsed")).toBe(true);
    expect(readReviewUiState<{ hit: number }>("window", "cache")).toEqual({
      hit: 1,
    });
  });

  it("keeps window scope out of localStorage so it dies with the window", () => {
    writeReviewUiState("window", "cache", 1);
    expect(window.sessionStorage.getItem("cache")).toBe("1");
    expect(window.localStorage.getItem("cache")).toBeNull();

    writeReviewUiState("session", "kept", 1);
    expect(window.localStorage.getItem("kept")).toBe("1");
    expect(window.sessionStorage.getItem("kept")).toBeNull();
  });

  it("falls back to null for missing and unreadable entries", () => {
    window.localStorage.setItem("broken", "{");
    window.localStorage.setItem("empty", "");
    // A value written by an older, non-JSON format must not throw.
    window.localStorage.setItem("legacy", "collapsed");

    expect(readReviewUiState("reader", "absent")).toBeNull();
    expect(readReviewUiState("reader", "broken")).toBeNull();
    expect(readReviewUiState("reader", "empty")).toBeNull();
    expect(readReviewUiState("reader", "legacy")).toBeNull();
  });

  it("removes single entries and whole key families", () => {
    writeReviewUiState("window", "nav:a", 1);
    writeReviewUiState("window", "nav:b", 2);
    writeReviewUiState("window", "other", 3);

    removeReviewUiState("window", "nav:a");
    expect(readReviewUiState("window", "nav:a")).toBeNull();

    forgetReviewUiState("window", (key) => key.startsWith("nav:"));
    expect(readReviewUiState("window", "nav:b")).toBeNull();
    expect(readReviewUiState("window", "other")).toBe(3);
  });

  it("keys reader scope without the session so it outlives one review", () => {
    const reader = reviewUiStateKey(null, "reader", "ui", "side-peek-width");
    const session = reviewUiStateKey(
      TEST_REVIEW_CONFIG,
      "session",
      "section",
      "Testing",
    );

    expect(reader).toBe("progressive-review:ui:side-peek-width");
    expect(session).toContain("progressive-review:section:");
    expect(session).not.toBe("progressive-review:section:Testing");
  });

  it("is the only module in the app that touches browser storage", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    const allowed = new Set(["review-ui-state.ts"]);

    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (/\.test\.tsx?$/.test(entry)) continue;
        if (allowed.has(path.relative(root, full))) continue;
        if (/window\.(local|session)Storage/.test(readFileSync(full, "utf8"))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
