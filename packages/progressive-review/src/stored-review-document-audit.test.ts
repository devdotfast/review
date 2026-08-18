import { describe, expect, it } from "vitest";

import { auditStoredReviewDocument } from "./stored-review-migration";

const reviewPath = "/reviews/current/review.mdx";

describe("auditStoredReviewDocument", () => {
  it.each([
    {
      syntax: "import type",
      source: 'import type { SequenceMessageInput } from "review-types";',
    },
    {
      syntax: "satisfies",
      source: "export const messages = [] satisfies SequenceMessageInput[];",
    },
    {
      syntax: "a type annotation",
      source: "export const messages: SequenceMessageInput[] = [];",
    },
  ])(
    "reports TypeScript-only $syntax as a standard-MDX parse error",
    ({ source }) => {
      expect(auditStoredReviewDocument(reviewPath, source)).toEqual([
        expect.objectContaining({
          code: "STANDARD_MDX_PARSE_ERROR",
          filePath: reviewPath,
          line: 1,
        }),
      ]);
    },
  );

  it("reports the former package import and its now-unbound helper separately", () => {
    const source = [
      'import { defineActors } from "@dev.fast/review/authoring";',
      "",
      'export const actors = defineActors({ user: { label: "User" } });',
    ].join("\n");

    expect(auditStoredReviewDocument(reviewPath, source)).toEqual([
      expect.objectContaining({
        code: "LEGACY_AUTHORING_IMPORT",
        filePath: reviewPath,
        line: 1,
      }),
      expect.objectContaining({
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: reviewPath,
        line: 3,
        message: expect.stringContaining("defineActors is no longer injected"),
      }),
    ]);
  });

  it.each([
    "defineActors",
    "defineAnchors",
    "defineSoftwareActors",
    "defineSoftwareModel",
    "defineSoftwareStores",
    "defineStores",
  ])("reports an unimported %s call", (helper) => {
    expect(
      auditStoredReviewDocument(
        reviewPath,
        `export const value = ${helper}({});`,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: reviewPath,
        line: 1,
        message: expect.stringContaining(`${helper} is no longer injected`),
      }),
    ]);
  });

  it("accepts helpers explicitly imported from the active Review session", () => {
    const source = [
      "import {",
      "  defineActors,",
      "  defineAnchors,",
      "  defineStores,",
      '} from "virtual:progressive-review-authoring";',
      "",
      'export const actors = defineActors({ user: { label: "User" } });',
      "",
      "export const anchors = defineAnchors({});",
      "",
      "export const stores = defineStores({});",
    ].join("\n");

    expect(auditStoredReviewDocument(reviewPath, source)).toEqual([]);
  });

  it("does not mistake helper names in prose or code fences for calls", () => {
    const source = [
      "# Migration notes",
      "",
      "The old document called defineActors here.",
      "",
      "```js",
      "defineAnchors({})",
      "```",
    ].join("\n");

    expect(auditStoredReviewDocument(reviewPath, source)).toEqual([]);
  });

  it("reports a repeatedly used missing helper once", () => {
    const source = [
      "export const first = defineAnchors({});",
      "",
      "export const second = defineAnchors({});",
    ].join("\n");

    expect(auditStoredReviewDocument(reviewPath, source)).toEqual([
      expect.objectContaining({
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: reviewPath,
        line: 1,
      }),
    ]);
  });

  it("reports every migration issue in a full Review 0.1.17 document", () => {
    // Representative of the 0.1.17 custom-compiler contract, ported from a
    // persisted ~/.dev review and the 0.1.17 default review document.
    const source = `---
softwareMap:
  repoRoot: "/workspace/dev-onboarding-v2"
  base: "rmwwlpln"
  head: "@"
  repo: "dev-onboarding-v2"
---

import type { SequenceMessageInput } from "@dev.fast/review/authoring";

export const actors = defineActors({
  composer: { label: "Draft composer" },
  agent: { label: "Question agent (instant)" },
  store: { label: "comments.json" },
  round: { label: "Next review round" },
});

export const oneControlFlow = [
  {
    from: actors.composer,
    to: actors.agent,
    label: "Default verb: instant answer",
    code: {
      language: "ts",
      text: "askQuestion(input)  // POST /__progressive-review/questions",
    },
  },
  {
    from: actors.agent,
    to: actors.composer,
    label: "Answer lands in the same thread card",
    code: {
      language: "ts",
      text: "status: running -> answered | error",
    },
  },
  {
    from: actors.composer,
    to: actors.store,
    label: "Alternative verb: save for the review round",
    code: {
      language: "ts",
      text: "saveComment(input)  // clientStatus: draft",
    },
  },
  {
    from: actors.store,
    to: actors.round,
    label: "Submit review; the agent answers it next round",
    code: {
      language: "ts",
      text: "POST /__progressive-review/submissions",
    },
  },
] satisfies SequenceMessageInput[];

export const anchors = defineAnchors({
  parseThreadTarget: {
    title: "parseThreadTarget",
    detail: "Server-side target parsing for every persisted comment target.",
    peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
  },
  resolveTargetState: {
    title: "resolveTargetState",
    detail: "Resolves a stored target against the current document and graph.",
    peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
  },
  askQuestion: {
    title: "askQuestion",
    detail: "Posts an instant question and replaces the optimistic response.",
    peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
  },
  saveComment: {
    title: "saveComment",
    detail: "Persists a draft for the next review round.",
    peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
  },
});

export const stores = defineStores({
  appDb: {
    kind: "relational",
    label: "comments.json",
    tables: {
      threads: {
        label: "threads",
        schema: {
          threadId: { type: "text", pk: true, example: "thread-123" },
          status: { type: "text", example: "open" },
        },
      },
    },
  },
});

# Plan: global comments and sidepeek selections

The prior change introduced durable thread targets. The next slice connects
those targets to the document and sidepeek surfaces without changing the
reviewer's current workflow.

The server starts in [\`parseThreadTarget\`](review://anchor/parseThreadTarget),
then [\`resolveTargetState\`](review://anchor/resolveTargetState) checks whether
the selected surface still exists.

## One control flow

<SequenceDiagram
  title="Ask now or save for the next round"
  messages={oneControlFlow}
/>

## Stored state

<DatabaseLens
  title="Review thread storage"
  stores={stores}
  anchors={anchors}
  height={460}
>
  <DbUseCase id="save-comment" label="Save a review comment">
    <DbWrite
      from={actors.composer}
      to={stores.appDb.tables.threads.fields.status}
      label="write draft status"
      anchor={anchors.saveComment}
    />
  </DbUseCase>
  <DbUseCase id="answer-question" label="Answer an instant question">
    <DbRead
      from={stores.appDb.tables.threads.fields.status}
      to={actors.agent}
      label="read current thread"
      anchor={anchors.askQuestion}
    />
  </DbUseCase>
</DatabaseLens>

## Implementation notes

<SidePeek anchor={anchors.askQuestion}>
  <CodePeek file="src/example.ts" fromLine={1} toLine={3} />
</SidePeek>

<SidePeek anchor={anchors.saveComment}>
  <CodePeek file="src/example.ts" fromLine={1} toLine={3} />
</SidePeek>

\`\`\`json
{
  "threadId": "thread-123",
  "status": "open",
  "target": { "kind": "document" },
  "messages": [
    {
      "by": "reviewer",
      "body": "Ship it after the target resolver is covered."
    }
  ]
}
\`\`\`

<SoftwareMap title="Repo software map" height={520} />
`;

    expect(auditStoredReviewDocument(reviewPath, source)).toEqual([
      {
        code: "STANDARD_MDX_PARSE_ERROR",
        filePath: reviewPath,
        line: 9,
        message: "Could not parse import/exports with acorn",
      },
      {
        code: "LEGACY_AUTHORING_IMPORT",
        filePath: reviewPath,
        line: 9,
        message: expect.stringContaining("Delete this TypeScript-only import"),
      },
      {
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: reviewPath,
        line: 11,
        message: expect.stringContaining("defineActors"),
      },
      {
        code: "STANDARD_MDX_PARSE_ERROR",
        filePath: reviewPath,
        line: 55,
        message: expect.stringContaining("satisfies"),
      },
      {
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: reviewPath,
        line: 57,
        message: expect.stringContaining("defineAnchors"),
      },
      {
        code: "IMPLICIT_AUTHORING_HELPER",
        filePath: reviewPath,
        line: 80,
        message: expect.stringContaining("defineStores"),
      },
    ]);
  });
});
