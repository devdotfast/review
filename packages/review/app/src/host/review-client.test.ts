import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  jsonReviewApiUrl,
  reviewApiUrl,
  reviewFetch,
  reviewStorageKey,
  reviewWasmUrl,
} from "./review-client";

const injectedConfig = {
  serverUrl: "http://127.0.0.1:5570",
  sessionUrl: "http://127.0.0.1:5570/sessions/desktop-session",
  routePath: "/pr/42",
  sessionId: "desktop-session",
  token: "secret-token",
  wasmUrl: "vscode-file://review/libavoid.wasm",
  appVersion: "0.0.13",
  theme: "dark",
  host: "desktop",
} satisfies ReviewRuntimeConfig;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review host client", () => {
  it("uses injected desktop routing and asset configuration", () => {
    expect(injectedConfig.host).toBe("desktop");
    expect(injectedConfig.routePath).toBe("/pr/42");
    expect(reviewApiUrl(injectedConfig, "/diff-files")).toBe(
      "http://127.0.0.1:5570/sessions/desktop-session/__progressive-review/diff-files?document=%2Fpr%2F42",
    );
    expect(reviewWasmUrl(injectedConfig)).toBe(
      "vscode-file://review/libavoid.wasm",
    );
    expect(reviewStorageKey(injectedConfig, "files", "main", "head")).toBe(
      "progressive-review:files:desktop-session:/pr/42:main:head",
    );
  });

  it("adds the desktop bearer token to API requests", async () => {
    let requestInit: RequestInit | undefined;

    const fetchMock: typeof fetch = async (_input, init) => {
      requestInit = init;

      return new Response(null, { status: 204 });
    };

    vi.stubGlobal("fetch", fetchMock);

    await reviewFetch(injectedConfig, "/session");

    expect(new Headers(requestInit?.headers).get("x-review-token")).toBe(
      "secret-token",
    );
  });
});

it("routes JSON reports and authenticated beacons without legacy document parameters", () => {
  const report = new URL(
    jsonReviewApiUrl(injectedConfig, "review/id", "/telemetry/bug-report", {
      version: 0,
    }),
  );

  expect(report.pathname).toBe("/reviews-api/review%2Fid/telemetry/bug-report");
  expect([...report.searchParams]).toEqual([["version", "0"]]);

  const beacon = new URL(
    jsonReviewApiUrl(
      {
        ...injectedConfig,
        serverUrl: "http://localhost:5570/",
        token: "a+b&c",
      },
      "review",
      "/telemetry/tab",
      { tokenInQuery: true },
    ),
  );

  expect(beacon.pathname).toBe("/reviews-api/review/telemetry/tab");
  expect(beacon.searchParams.get("token")).toBe("a+b&c");
  expect(beacon.searchParams.has("document")).toBe(false);
});
