// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import type { AnchorRef } from "../../src/authoring";
import { ReviewSessionProvider } from "./host/review-session";
import { testReviewSession } from "./review-session-test-utils";
import { buildGraphTarget } from "./target-fingerprint";
import {
  ThreadTargetModelProvider,
  useLiveAnchors,
  useRegisterLiveDiagram,
} from "./thread-target-model";

const session = testReviewSession();

function withSession(child: React.ReactNode) {
  return (
    <ReviewSessionProvider session={session}>{child}</ReviewSessionProvider>
  );
}

function Diagram({ label }: { label: string }) {
  useRegisterLiveDiagram({
    label,
    elements: [
      buildGraphTarget({
        diagram: label,
        type: "node",
        path: ["Node"],
        payload: { label: "Node" },
        quote: "Node",
      }),
    ],
  });
  return null;
}

function FirstDiagramDocument() {
  return <Diagram label="Request flow" />;
}

function SecondDiagramDocument() {
  return <Diagram label="Request flow" />;
}

function AnchorContent({ anchorId }: { anchorId: string }) {
  return useLiveAnchors().get(anchorId)?.content?.text ?? null;
}

describe("diagram target registry", () => {
  it("rejects duplicate diagram labels in one document", () => {
    expect(() =>
      renderToStaticMarkup(
        withSession(
          createElement(
            ThreadTargetModelProvider,
            {
              anchors: new Map(),
              anchorContents: new Map(),
            },
            createElement(Diagram, { label: "Request flow" }),
            createElement(Diagram, { label: "Request flow" }),
          ),
        ),
      ),
    ).toThrow(ZodError);
  });

  it("replaces a document without retaining its diagram labels", async () => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const renderDocument = (
      anchors: ReadonlyMap<string, AnchorRef>,
      Document: () => React.ReactElement,
    ) =>
      withSession(
        <ThreadTargetModelProvider
          anchors={anchors}
          anchorContents={new Map<string, string>()}
        >
          <Document />
        </ThreadTargetModelProvider>,
      );

    try {
      await act(async () => {
        root.render(
          renderDocument(new Map<string, AnchorRef>(), FirstDiagramDocument),
        );
      });
      await expect(
        act(async () => {
          root.render(
            renderDocument(new Map<string, AnchorRef>(), SecondDiagramDocument),
          );
        }),
      ).resolves.toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("provides authored anchor content from the document model", () => {
    expect(
      renderToStaticMarkup(
        withSession(
          createElement(
            ThreadTargetModelProvider,
            {
              anchors: new Map([
                [
                  "runtime",
                  {
                    __kind: "db-anchor-ref" as const,
                    id: "runtime",
                    title: "Runtime",
                  },
                ],
              ]),
              anchorContents: new Map([["runtime", "request\nresponse"]]),
            },
            createElement(AnchorContent, { anchorId: "runtime" }),
          ),
        ),
      ),
    ).toContain("request\nresponse");
  });
});
