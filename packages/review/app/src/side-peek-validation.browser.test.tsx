import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewDebugSettingsProvider } from "./debug-settings";
import { ReviewSessionProvider } from "./host/review-session";
import { AnchorLink, ReviewPanelHost } from "./review-components";
import { ReviewProvider } from "./review-context";
import { createTestReviewDefinitionSession } from "./review-definition-test-utils";
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { ReviewPanelProvider } from "./review-panel";
import { testReviewSession } from "./review-session-test-utils";
import { defineSoftwareModel } from "./software-map/model";

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
    const session = testReviewSession();
    const model = defineSoftwareModel({ systems: {} });
    const validatedRoots: string[] = [];

    const definitions = createTestReviewDefinitionSession({
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
        <ReviewSessionProvider session={session}>
          <ReviewDebugSettingsProvider>
            <ReviewProvider>
              <ReviewPanelProvider>
                <ReviewDocumentBoundary
                  revision="valid"
                  onError={() => {}}
                  session={session}
                >
                  <AnchorLink anchor={anchors.startup}>Startup</AnchorLink>
                </ReviewDocumentBoundary>
                <div className="review-detail-host">
                  <ReviewPanelHost />
                </div>
              </ReviewPanelProvider>
            </ReviewProvider>
          </ReviewDebugSettingsProvider>
        </ReviewSessionProvider>,
      );
      await Promise.resolve();
    });

    const validationCountBeforeOpen = validatedRoots.length;

    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="#review-anchor-startup"]',
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
