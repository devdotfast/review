// @vitest-environment jsdom

import type { ReviewVerbRequest } from "@dev.fast/review-protocol";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testReviewSession } from "../review-session-test-utils";
import { ReviewSessionProvider, useReviewSession } from "./review-session";

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ReviewSessionProvider", () => {
  it("routes data requests through the owning desktop model", async () => {
    const request = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const session = testReviewSession({}, { request });

    await session.fetch("/comments");

    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:5570/sessions/test-session/__progressive-review/comments?document=%2Freview.mdx",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const requestHeaders = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("x-review-token")).toBe("secret-token");
  });

  it("keeps mounted sessions independent when a sibling session unmounts", async () => {
    const postedA: ReviewVerbRequest[] = [];
    const postedB: ReviewVerbRequest[] = [];
    const sessionA = testReviewSession(
      {
        sessionUrl: "http://127.0.0.1:5570/sessions/a",
        sessionId: "a",
        routePath: "/a.mdx",
        token: "token-a",
      },
      {
        post: async (request) => {
          postedA.push(request);
          return { ok: true };
        },
      },
    );
    const sessionB = testReviewSession(
      {
        sessionUrl: "http://127.0.0.1:5570/sessions/b",
        sessionId: "b",
        routePath: "/b.mdx",
        token: "token-b",
      },
      {
        post: async (request) => {
          postedB.push(request);
          return { ok: true };
        },
      },
    );
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.append(containerA, containerB);
    const rootA = createRoot(containerA);
    const rootB = createRoot(containerB);
    roots.push(rootA, rootB);
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      rootA.render(
        <ReviewSessionProvider session={sessionA}>
          <SessionProbe />
        </ReviewSessionProvider>,
      );
      rootB.render(
        <ReviewSessionProvider session={sessionB}>
          <SessionProbe />
        </ReviewSessionProvider>,
      );
    });

    expect(containerA.querySelector("output")?.textContent).toContain(
      "/sessions/a/__progressive-review/session",
    );
    expect(containerA.querySelector("output")?.textContent).toContain(
      "progressive-review:probe:a:/a.mdx",
    );
    expect(containerB.querySelector("output")?.textContent).toContain(
      "/sessions/b/__progressive-review/session",
    );
    expect(containerB.querySelector("output")?.textContent).toContain(
      "progressive-review:probe:b:/b.mdx",
    );

    await act(async () => rootA.unmount());
    roots.splice(roots.indexOf(rootA), 1);
    await act(async () => {
      containerB.querySelector("button")?.click();
    });
    await sessionB.fetch("/session");

    expect(postedA).toEqual([]);
    expect(postedB).toEqual([
      { name: "showReviewView", args: { view: "diff" } },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:5570/sessions/b/__progressive-review/session?document=%2Fb.mdx",
      expect.objectContaining({
        headers: expect.objectContaining({}),
      }),
    );
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("x-review-token")).toBe("token-b");
  });
});

function SessionProbe() {
  const session = useReviewSession();
  const [clicks, setClicks] = useState(0);
  return (
    <>
      <output>
        {session.apiUrl("/session")} {session.storageKey("probe")} {clicks}
      </output>
      <button
        type="button"
        onClick={() => {
          session.surface.post({
            name: "showReviewView",
            args: { view: "diff" },
          });
          setClicks((current) => current + 1);
        }}
      >
        Open files
      </button>
    </>
  );
}
