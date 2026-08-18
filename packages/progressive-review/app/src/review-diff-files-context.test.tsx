// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import {
  ReviewDiffFilesProvider,
  useReviewDiffFiles,
} from "./review-diff-files-context";
import { testReviewSession } from "./review-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;
const session = testReviewSession();

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewDiffFilesProvider", () => {
  it("starts one patch-free request after commit and shares it with every consumer", async () => {
    let committed = false;
    let resolveRequest!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(() => {
      expect(committed).toBe(true);
      return pendingResponse;
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe({ label }: { label: string }) {
      const state = useReviewDiffFiles();
      useLayoutEffect(() => {
        committed = true;
      }, []);
      return (
        <span>
          {label}:{state.status}
          {state.status === "loaded" ? `:${state.files.length}` : ""}
        </span>
      );
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-one">
            <Probe label="one" />
            <Probe label="two" />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ includePatch: false }),
    });

    await act(async () => {
      resolveRequest(
        new Response(
          JSON.stringify({
            ok: true,
            files: [
              {
                path: "src/current.ts",
                status: "modified",
                additions: 8,
                deletions: 3,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      await pendingResponse;
    });
    expect(container.textContent).toContain("one:loaded:1");
    expect(container.textContent).toContain("two:loaded:1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never exposes or restores files from a previous document key", async () => {
    let resolveSecondDocument!: (value: unknown) => void;
    const secondDocument = new Promise<unknown>((resolve) => {
      resolveSecondDocument = resolve;
    });
    const responses = [
      responseWithJson({
        ok: true,
        files: [
          {
            path: "src/first.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
          },
        ],
      }),
      responseWithJson(secondDocument),
      responseWithJson({
        ok: true,
        files: [
          {
            path: "src/third.ts",
            status: "modified",
            additions: 3,
            deletions: 0,
          },
        ],
      }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const committedStates: string[] = [];

    function Probe() {
      const state = useReviewDiffFiles();
      const label =
        state.status === "loaded"
          ? `loaded:${state.files[0]?.path}`
          : state.status;
      useLayoutEffect(() => {
        committedStates.push(label);
      });
      return <span>{label}</span>;
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-one">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(container.textContent).toBe("loaded:src/first.ts");

    const transitionStart = committedStates.length;
    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-two">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(committedStates.slice(transitionStart)).not.toContain(
      "loaded:src/first.ts",
    );
    expect(container.textContent).toBe("loading");

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-three">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(container.textContent).toBe("loaded:src/third.ts");

    await act(async () => {
      resolveSecondDocument({
        ok: true,
        files: [
          {
            path: "src/second.ts",
            status: "modified",
            additions: 2,
            deletions: 0,
          },
        ],
      });
      await secondDocument;
    });
    expect(container.textContent).toBe("loaded:src/third.ts");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function responseWithJson(json: unknown | Promise<unknown>): Response {
  return {
    ok: true,
    json: async () => json,
  } as Response;
}
