// @vitest-environment jsdom

import { parseJsonText } from "@dev.fast/json";
import type { ReviewCanvasTutorialBridge } from "@dev.fast/review-protocol";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider } from "./review-context";
import { reviewTocEntries } from "./review-document-headings";
import { hydrateReviewDocument } from "./review-document-hydrate";
import {
  projectReviewDocument,
  useReviewDocumentProjection,
} from "./review-document-projection";
import { ReviewDocumentContent } from "./review-document-surface";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";

const tutorial: ReviewCanvasTutorialBridge = {
  content: {
    reviewUuid: "test",
    progress: { version: 1, checked: [], dismissed: false },
    keymap: "none",
  },
  setStep() {},
  dismiss() {},
  reopen() {},
  async selectKeymap() {},
  close() {},
};

function source() {
  const heading = (value: string, id?: string) => ({
    type: "element",
    tag: "h3",
    props: id ? { id } : {},
    children: [{ type: "text", value }],
  });

  const paragraph = {
    type: "element",
    tag: "p",
    props: {},
    children: [{ type: "text", value: "Feature guidance" }],
  };

  return hydrateReviewDocument({
    state: "ready",
    contentHash: "projection",
    data: parseJsonText(
      JSON.stringify({
        format: "review-document/1",
        title: "Projection",
        routePath: "/",
        sourcePath: "review.mdx",
        anchors: {},
        anchorContents: {},
        softwareModels: [],
        body: [
          {
            type: "component",
            name: "ReviewSection",
            props: { title: "Section", defaultCollapsed: true },
            children: [
              {
                type: "component",
                name: "TutorialFeature",
                props: { feature: "softwareMap" },
                children: [
                  heading("Shared"),
                  heading("Reserved", "reserved"),
                  paragraph,
                ],
              },
              {
                type: "component",
                name: "TutorialViewButton",
                props: { view: "map" },
                children: [heading("Button"), paragraph],
              },
              heading("Shared"),
              heading("Reserved"),
              {
                type: "component",
                name: "TutorialAuthoringConversation",
                props: {
                  conversation: {
                    version: 1,
                    title: "Conversation",
                    messages: [
                      { role: "user", body: "Explain the flow." },
                      { role: "assistant", body: "Here is the flow." },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      }),
    ),
  }).body;
}

function render(projection: ReturnType<typeof projectReviewDocument>) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <ReviewSessionProvider session={testReviewSession()}>
      <ReviewProvider
        softwareMapEnabled={projection.context.softwareMapEnabled}
      >
        <TutorialProvider
          tutorial={projection.context.tutorial ? tutorial : undefined}
        >
          <ReviewDocumentContent body={projection.body} />
        </TutorialProvider>
      </ReviewProvider>
    </ReviewSessionProvider>,
  );

  return container;
}

it.each([
  { tutorial: false, softwareMapEnabled: true, paragraphs: 2 },
  { tutorial: true, softwareMapEnabled: false, paragraphs: 2 },
  { tutorial: true, softwareMapEnabled: true, paragraphs: 4 },
])(
  "matches rendered headings and collapsed paragraph labels for %j",
  (context) => {
    const projection = projectReviewDocument(source(), context);
    const container = render(projection);
    expect(reviewTocEntries(projection.body)).toEqual(
      [...container.querySelectorAll("h2,h3")].map((heading) => ({
        id: heading.id,
        text: heading.textContent,
        level: heading.tagName.toLowerCase(),
      })),
    );
    expect(container.querySelectorAll(".review-section-body p")).toHaveLength(
      context.paragraphs,
    );
    expect(container.querySelector(".review-section-meta")?.textContent).toBe(
      `${context.paragraphs} paragraphs`,
    );
  },
);

it("retains visible IDs through feature toggles and leaves the source and speculative projections untouched", () => {
  const body = source();
  const saved = JSON.stringify(body);
  const disabled = { tutorial: true, softwareMapEnabled: false };
  const enabled = { tutorial: true, softwareMapEnabled: true };
  const first = projectReviewDocument(body, disabled);
  expect(reviewTocEntries(first.body).map(({ id }) => id)).toEqual([
    "section",
    "shared",
    "reserved",
  ]);
  const next = projectReviewDocument(body, enabled, first);
  expect(
    reviewTocEntries(next.body)
      .filter(({ text }) => text === "Shared")
      .map(({ id }) => id),
  ).toEqual(["shared-2", "shared"]);
  const last = projectReviewDocument(body, disabled, next);
  expect(reviewTocEntries(last.body)).toEqual(reviewTocEntries(first.body));
  projectReviewDocument(
    body,
    { tutorial: false, softwareMapEnabled: false },
    next,
  );
  expect(
    reviewTocEntries(projectReviewDocument(body, enabled, next).body),
  ).toEqual(reviewTocEntries(next.body));
  expect(JSON.stringify(body)).toBe(saved);
  expect(render(next).querySelector(".review-section-meta")?.textContent).toBe(
    "4 paragraphs",
  );
});

it("keeps rendered heading IDs stable through Strict Mode feature updates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const body = source();
  const container = document.createElement("div");
  const root = createRoot(container);

  function Content({ enabled }: { enabled: boolean }) {
    const projected = useReviewDocumentProjection(body, {
      tutorial: true,
      softwareMapEnabled: enabled,
    });

    return (
      <ReviewSessionProvider session={testReviewSession()}>
        <ReviewProvider softwareMapEnabled={enabled}>
          <TutorialProvider tutorial={tutorial}>
            <ReviewDocumentContent body={projected} />
          </TutorialProvider>
        </ReviewProvider>
      </ReviewSessionProvider>
    );
  }

  try {
    await act(() =>
      root.render(
        <StrictMode>
          <Content enabled={false} />
        </StrictMode>,
      ),
    );
    expect(
      [...container.querySelectorAll("h3")].map((heading) => heading.id),
    ).toEqual(["shared", "reserved"]);
    await act(() =>
      root.render(
        <StrictMode>
          <Content enabled />
        </StrictMode>,
      ),
    );
    expect(
      [...container.querySelectorAll("h3")].flatMap((heading) =>
        heading.textContent === "Shared" ? [heading.id] : [],
      ),
    ).toEqual(["shared-2", "shared"]);
    await act(() =>
      root.render(
        <StrictMode>
          <Content enabled={false} />
        </StrictMode>,
      ),
    );
    expect(
      [...container.querySelectorAll("h3")].map((heading) => heading.id),
    ).toEqual(["shared", "reserved"]);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
