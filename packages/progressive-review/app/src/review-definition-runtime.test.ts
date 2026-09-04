import { afterEach, expect, it, vi } from "vitest";

import {
  resolveCodePeekRequest,
  runWithCodePeekResolutionSlot,
} from "./review-definition-runtime";
import { testReviewSession } from "./review-session-test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("bounds concurrent CodePeek requests to the running server", async () => {
  let active = 0;
  let maximumActive = 0;

  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      runWithCodePeekResolutionSlot(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
      }),
    ),
  );

  expect(maximumActive).toBe(8);
});

it("resolves peeks through the configured ReviewSession request path", async () => {
  const sourceId = "source-range:src/example.ts:1-3";
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          snapshot: {
            roots: [{ kind: "source", sourceId }],
            resolved: {},
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const session = testReviewSession({
    sessionUrl: "http://localhost:5620/sessions/review-a",
    routePath: "/default",
    token: "session-secret",
  });

  await resolveCodePeekRequest(
    "/guide",
    { file: "src/example.ts", fromLine: 1, toLine: 3 },
    session,
  );

  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    "http://localhost:5620/sessions/review-a/__progressive-review/code-peek/resolve?document=%2Fguide",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    includeDiff: false,
    includeDiffSummary: true,
  });
  expect(
    new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-review-token"),
  ).toBe("session-secret");
});
