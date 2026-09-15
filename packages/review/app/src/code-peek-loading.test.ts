import { describe, expect, it } from "vitest";

import { codePeekLoadState } from "./CodePeek";

describe("CodePeek loading state", () => {
  it("shows an initial loading state before the resolver effect starts", () => {
    expect(
      codePeekLoadState({
        requestKey: "request",
        pendingKey: null,
        displayedKey: null,
        error: null,
      }),
    ).toEqual({ isInitialLoad: true, isRefreshing: false });
  });

  it("keeps an existing result visible while a refresh is pending", () => {
    expect(
      codePeekLoadState({
        requestKey: "request",
        pendingKey: "request",
        displayedKey: "request",
        error: null,
      }),
    ).toEqual({ isInitialLoad: false, isRefreshing: true });
  });

  it("does not mask missing input or a resolver error as loading", () => {
    expect(
      codePeekLoadState({
        requestKey: "",
        pendingKey: null,
        displayedKey: null,
        error: null,
      }).isInitialLoad,
    ).toBe(false);
    expect(
      codePeekLoadState({
        requestKey: "request",
        pendingKey: null,
        displayedKey: null,
        error: "failed",
      }).isInitialLoad,
    ).toBe(false);
  });
});
