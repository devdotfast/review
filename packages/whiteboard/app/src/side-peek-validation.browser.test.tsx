import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhiteboardDebugSettingsProvider } from "./debug-settings";
import { WhiteboardSessionProvider } from "./host/whiteboard-session";
import { defineSoftwareModel } from "./software-map/model";
import { AnchorLink, WhiteboardPanelHost } from "./whiteboard-components";
import { WhiteboardProvider } from "./whiteboard-context";
import { createTestWhiteboardDefinitionSession } from "./whiteboard-definition-test-utils";
import { WhiteboardDocumentBoundary } from "./whiteboard-document-boundary";
import { WhiteboardPanelProvider } from "./whiteboard-panel";
import { testWhiteboardSession } from "./whiteboard-session-test-utils";

const roots: Array<ReturnType<typeof createRoot>> = [];

describe("side-peek validation boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}))),
    );
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens an eagerly validated anchor CodePeek outside the document provider", async () => {
    const session = testWhiteboardSession();
    const model = defineSoftwareModel({ systems: {} });
    const validatedRoots: string[] = [];

    const definitions = createTestWhiteboardDefinitionSession({
      softwareMap: model,
      validateCodePeek: async (props) => {
        validatedRoots.push(props.file);
      },
    });

    const anchors = definitions.defineAnchors({
      startup: {
        title: "Startup",
        peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      },
    });

    await definitions.ready();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <WhiteboardSessionProvider session={session}>
          <WhiteboardDebugSettingsProvider>
            <WhiteboardProvider>
              <WhiteboardPanelProvider>
                <WhiteboardDocumentBoundary
                  revision="valid"
                  onError={() => {}}
                  session={session}
                >
                  <AnchorLink anchor={anchors.startup}>Startup</AnchorLink>
                </WhiteboardDocumentBoundary>
                <div className="whiteboard-detail-host">
                  <WhiteboardPanelHost />
                </div>
              </WhiteboardPanelProvider>
            </WhiteboardProvider>
          </WhiteboardDebugSettingsProvider>
        </WhiteboardSessionProvider>,
      );
      await Promise.resolve();
    });

    const validationCountBeforeOpen = validatedRoots.length;

    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="#whiteboard-anchor-startup"]',
    );

    expect(link).not.toBeNull();

    await act(async () => {
      link!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".code-peek")).not.toBeNull();
    expect(validatedRoots).toHaveLength(validationCountBeforeOpen);

    const codePeekFetches = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) =>
        String(input).includes("/code-peek/resolve"),
      );

    expect(codePeekFetches).toHaveLength(0);
  });
});
