import type { WhiteboardDiffFileWire } from "@dev.fast/whiteboard-protocol";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import {
  WhiteboardDiffFilesProvider,
  useWhiteboardDiffFiles,
} from "./whiteboard-diff-files-context";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhiteboardDiffFilesProvider", () => {
  it("reads the desktop's prefetched diff without a network request", async () => {
    const files = vi.fn<() => Promise<WhiteboardDiffFileWire[]>>(async () => [
      {
        path: "src/prefetched.ts",
        status: "modified" as const,
        additions: 4,
        deletions: 2,
        patch: "diff --git a/src/prefetched.ts b/src/prefetched.ts",
      },
    ]);

    const nativeSession = testWhiteboardSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused test diff view");
          },
          files,
        },
      },
    );

    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe() {
      const state = useWhiteboardDiffFiles();

      return (
        <span>
          {state.status === "loaded" ? state.files[0]?.path : state.status}
        </span>
      );
    }

    await act(async () => {
      root!.render(
        <WhiteboardSessionProvider session={nativeSession}>
          <WhiteboardDiffFilesProvider documentKey="whiteboard-one">
            <Probe />
          </WhiteboardDiffFilesProvider>
        </WhiteboardSessionProvider>,
      );
    });

    expect(container.textContent).toBe("src/prefetched.ts");
    expect(files).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts one request after commit and shares it with every consumer", async () => {
    let committed = false;
    let resolveRequest!: (response: WhiteboardDiffFileWire[]) => void;

    const pendingResponse = new Promise<WhiteboardDiffFileWire[]>((resolve) => {
      resolveRequest = resolve;
    });

    const files = vi.fn<() => Promise<WhiteboardDiffFileWire[]>>(() => {
      expect(committed).toBe(true);

      return pendingResponse;
    });

    const session = testWhiteboardSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused");
          },
          files,
        },
      },
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe({ label }: { label: string }) {
      const state = useWhiteboardDiffFiles();
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
        <WhiteboardSessionProvider session={session}>
          <WhiteboardDiffFilesProvider documentKey="whiteboard-one">
            <Probe label="one" />
            <Probe label="two" />
          </WhiteboardDiffFilesProvider>
        </WhiteboardSessionProvider>,
      );
    });
    expect(files).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest([
        {
          path: "src/current.ts",
          status: "modified",
          additions: 8,
          deletions: 3,
        },
      ]);
      await pendingResponse;
    });
    expect(container.textContent).toContain("one:loaded:1");
    expect(container.textContent).toContain("two:loaded:1");
    expect(files).toHaveBeenCalledTimes(1);
  });

  it("never exposes or restores files from a previous document key", async () => {
    let resolveSecondDocument!: (value: WhiteboardDiffFileWire[]) => void;

    const secondDocument = new Promise<WhiteboardDiffFileWire[]>((resolve) => {
      resolveSecondDocument = resolve;
    });

    const responses = [
      Promise.resolve([
        {
          path: "src/first.ts",
          status: "modified" as const,
          additions: 1,
          deletions: 0,
        },
      ]),
      secondDocument,
      Promise.resolve([
        {
          path: "src/third.ts",
          status: "modified" as const,
          additions: 3,
          deletions: 0,
        },
      ]),
    ];

    const files = vi.fn<() => Promise<WhiteboardDiffFileWire[]>>(
      async () => responses.shift()!,
    );

    const session = testWhiteboardSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused");
          },
          files,
        },
      },
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const committedStates: string[] = [];

    function Probe() {
      const state = useWhiteboardDiffFiles();

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
        <WhiteboardSessionProvider session={session}>
          <WhiteboardDiffFilesProvider documentKey="whiteboard-one">
            <Probe />
          </WhiteboardDiffFilesProvider>
        </WhiteboardSessionProvider>,
      );
    });
    expect(container.textContent).toBe("loaded:src/first.ts");

    const transitionStart = committedStates.length;
    await act(async () => {
      root!.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardDiffFilesProvider documentKey="whiteboard-two">
            <Probe />
          </WhiteboardDiffFilesProvider>
        </WhiteboardSessionProvider>,
      );
    });
    expect(committedStates.slice(transitionStart)).not.toContain(
      "loaded:src/first.ts",
    );
    expect(container.textContent).toBe("loading");

    await act(async () => {
      root!.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardDiffFilesProvider documentKey="whiteboard-three">
            <Probe />
          </WhiteboardDiffFilesProvider>
        </WhiteboardSessionProvider>,
      );
    });
    expect(container.textContent).toBe("loaded:src/third.ts");

    await act(async () => {
      resolveSecondDocument([
        {
          path: "src/second.ts",
          status: "modified",
          additions: 2,
          deletions: 0,
        },
      ]);
      await secondDocument;
    });
    expect(container.textContent).toBe("loaded:src/third.ts");
    expect(files).toHaveBeenCalledTimes(3);
  });
});
