import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import type {
  AuthoredTargetRef,
  CodePeekProps,
  ReviewAuthoringComponentRegistry,
  SequenceDiagramProps,
  SequenceMessageInput,
} from "../../src/authoring";
import {
  anchorLinkPropsSchema,
  databaseLensPropsSchema,
  dbOperationPropsSchema,
  dbUseCasePropsSchema,
  resolveTargetRef,
  reviewCodePeekPropsSchema,
  reviewSectionPropsSchema,
  sequenceDiagramPropsSchema,
  softwareMapPropsSchema,
  tutorialFeaturePropsSchema,
  tutorialViewButtonPropsSchema,
} from "../../src/authoring";
import { validatedCodePeekInputFromRef } from "./CodePeek";
import { createSequence } from "./diagrams";
import { reviewAuthoringComponents } from "./review-authoring-components";
import { createTestReviewDefinitionSession } from "./review-definition-test-utils";
import { ReviewDocumentContent } from "./review-document-surface";

const definitionSession = createTestReviewDefinitionSession();
const { defineActors, defineAnchors, defineStores } = definitionSession;

const runtimeRegistry =
  reviewAuthoringComponents satisfies ReviewAuthoringComponentRegistry;

const actors = defineActors({
  browser: { label: "Browser" },
  api: { label: "API" },
});
const anchors = defineAnchors({
  request: {
    title: "Request",
    peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
  },
  summary: "Summary",
});

const stores = defineStores({
  app: {
    kind: "relational",
    label: "Application database",
    tables: {
      reviews: {
        schema: {
          id: { type: "text" },
          path: { type: "text" },
          schema: { type: "text" },
          storeId: { type: "text" },
          metadata: {
            author: { type: "text" },
          },
          payload: {
            type: "json",
            schema: {
              status: { type: "text" },
            },
          },
        },
      },
    },
  },
});

const actorKeyInference = actors.browser;
const collectionKeyInference: AuthoredTargetRef = stores.app.tables.reviews;
const fieldKeyInference: AuthoredTargetRef = stores.app.tables.reviews.id;
const nestedFieldKeyInference: AuthoredTargetRef =
  stores.app.tables.reviews.metadata.author;
const leafSchemaKeyInference: AuthoredTargetRef =
  stores.app.tables.reviews.payload.status;
const reservedNameFieldInference: AuthoredTargetRef =
  stores.app.tables.reviews.path;

// These compile-time assertions make drift in the public authoring contract a
// failure of the package typecheck, while the Vitest assertion below protects
// the concrete runtime registry.
// @ts-expect-error defineActors must retain the authored key set.
void actors.worker;
// @ts-expect-error defineAnchors must retain the authored key set.
void anchors.missing;
// @ts-expect-error defineStores must retain collection keys.
void stores.app.tables.users;
// @ts-expect-error defineStores must retain field keys.
void stores.app.tables.reviews.missing;

const validCodePeek: CodePeekProps = {
  file: "src/review.ts",
  fromLine: 1,
  toLine: 2,
};
// @ts-expect-error A CodePeek requires a file.
const invalidCodePeek: CodePeekProps = { fromLine: 1, toLine: 2 };

const validInlineActorMessage: SequenceMessageInput = {
  from: actors.browser,
  to: { label: "Worker" },
  label: "Dispatch",
  code: { language: "http", text: "POST /jobs" },
};
const validPeekMessage: SequenceMessageInput = {
  from: actors.browser,
  to: actors.api,
  label: "Request",
  anchor: anchors.request,
};
const invalidStringActorMessage: SequenceMessageInput = {
  // @ts-expect-error Plain strings are not actor references.
  from: "Browser",
  // @ts-expect-error Plain strings are not actor references.
  to: "API",
  label: "Request",
  code: "GET /reviews",
};
// @ts-expect-error A sequence message needs inline code or a peekable anchor.
const invalidUninspectableMessage: SequenceMessageInput = {
  from: actors.browser,
  to: actors.api,
  label: "Request",
  anchor: anchors.summary,
};
// @ts-expect-error A sequence message cannot omit both anchor and code.
const invalidEmptyMessage: SequenceMessageInput = {
  from: actors.browser,
  to: actors.api,
  label: "Request",
};

const invalidSequenceChildren: SequenceDiagramProps = {
  label: "Request",
  messages: [validInlineActorMessage],
  // @ts-expect-error SequenceDiagram is a leaf authoring component.
  children: "unsupported",
};

void actorKeyInference;
void fieldKeyInference;
void nestedFieldKeyInference;
void leafSchemaKeyInference;
void validCodePeek;
void validPeekMessage;
void invalidCodePeek;
void invalidStringActorMessage;
void invalidUninspectableMessage;
void invalidEmptyMessage;
void invalidSequenceChildren;

describe("review authoring contract", () => {
  it("threads resolved authored CodePeek code into the native preview", async () => {
    await definitionSession.ready();

    expect(validatedCodePeekInputFromRef(anchors.request.peek)).toMatchObject({
      props: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      resolution: anchors.request.peek.resolution,
    });
  });

  it("rejects an unresolved authored anchor before the definition barrier", () => {
    const ref = {
      __kind: "code-peek-ref" as const,
      props: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      resolution: null,
    };

    expect(() => validatedCodePeekInputFromRef(ref)).toThrow(
      "defineAnchors must finish before React mounts",
    );
  });

  it("is satisfied by the exact runtime component registry", () => {
    expect(Object.keys(runtimeRegistry).sort()).toEqual([
      "AnchorLink",
      "CallStackDiff",
      "CodePeek",
      "DatabaseLens",
      "DbRead",
      "DbUseCase",
      "DbWrite",
      "ReviewSection",
      "SequenceDiagram",
      "TraceQuote",
      "TutorialFeature",
      "TutorialKeymapPicker",
      "TutorialViewButton",
    ]);
  });

  it("renders map-free review document content without either repo map", () => {
    const html = renderToStaticMarkup(
      <ReviewDocumentContent
        ReviewDocument={() => <p>Map-free review prose</p>}
      />,
    );

    expect(html).toContain("Map-free review prose");
  });

  it("uses the package-owned helper implementation at runtime", () => {
    expect(actorKeyInference).toMatchObject({
      __kind: "db-actor-ref",
      id: "browser",
      label: "Browser",
    });
    expect(resolveTargetRef(collectionKeyInference)).toMatchObject({
      __kind: "db-target-ref",
      path: [],
    });
    expect(resolveTargetRef(fieldKeyInference)).toMatchObject({
      __kind: "db-target-ref",
      path: ["id"],
    });
    expect(resolveTargetRef(nestedFieldKeyInference)?.path).toEqual([
      "metadata",
      "author",
    ]);
    expect(resolveTargetRef(leafSchemaKeyInference)?.path).toEqual([
      "payload",
      "status",
    ]);
    expect(resolveTargetRef(reservedNameFieldInference)?.path).toEqual([
      "path",
    ]);
  });

  it("accepts exact collection and field targets for database operations", () => {
    expect(
      dbOperationPropsSchema.parse({
        from: stores.app.tables.reviews,
        to: actors.browser,
        label: "Read reviews",
        anchor: anchors.request,
      }),
    ).toMatchObject({ from: { path: [] } });
    expect(
      dbOperationPropsSchema.parse({
        from: actors.api,
        to: stores.app.tables.reviews.path,
        label: "Write path",
        anchor: anchors.request,
      }),
    ).toMatchObject({ to: { path: ["path"] } });
  });

  it.each([
    [
      "CodePeek",
      reviewCodePeekPropsSchema,
      { anchor: anchors.request, extra: true },
    ],
    [
      "AnchorLink",
      anchorLinkPropsSchema,
      { anchor: anchors.request, children: "Request", extra: true },
    ],
    [
      "ReviewSection",
      reviewSectionPropsSchema,
      { title: "Overview", children: "Body", extra: true },
    ],
    [
      "SequenceDiagram",
      sequenceDiagramPropsSchema,
      {
        label: "Request",
        messages: [validInlineActorMessage],
        extra: true,
      },
    ],
    [
      "DatabaseLens",
      databaseLensPropsSchema,
      {
        stores,
        children: "Use cases",
        extra: true,
      },
    ],
    [
      "DbUseCase",
      dbUseCasePropsSchema,
      { id: "request", label: "Request", children: "Operations", extra: true },
    ],
    [
      "DbRead",
      dbOperationPropsSchema,
      {
        from: actors.browser,
        to: stores.app.tables.reviews.id,
        label: "Read",
        anchor: anchors.request,
        extra: true,
      },
    ],
    [
      "DbWrite",
      dbOperationPropsSchema,
      {
        from: actors.api,
        to: stores.app.tables.reviews.id,
        label: "Write",
        anchor: anchors.request,
        extra: true,
      },
    ],
    ["SoftwareMap", softwareMapPropsSchema, { title: "Map", extra: true }],
    [
      "TutorialFeature",
      tutorialFeaturePropsSchema,
      { feature: "softwareMap", children: "Map", extra: true },
    ],
    [
      "TutorialViewButton",
      tutorialViewButtonPropsSchema,
      { view: "commits", children: "Commits", extra: true },
    ],
  ] as const)("uses a strict runtime schema for %s", (_name, schema, input) => {
    expect(() => schema.parse(input)).toThrow(ZodError);
  });

  it.each([
    ["from", "HeyGen"],
    ["to", 42],
  ] as const)(
    "rejects an invalid SequenceDiagram messages[0].%s before actor access",
    (property, invalidValue) => {
      const message: Record<string, unknown> = {
        from: actors.browser,
        to: actors.api,
        label: "Request",
        code: "GET /reviews",
      };
      message[property] = invalidValue;

      let caught: unknown;
      try {
        createSequence({
          label: "Request",
          messages: [message as never],
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ZodError);
      const issues = (caught as ZodError).issues;
      expect(issues[0]?.path).toEqual(["messages", 0]);
      expect(JSON.stringify(issues)).toContain(`"${property}"`);
    },
  );
});
