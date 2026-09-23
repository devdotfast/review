import { expect, it } from "vitest";

import { selectSource } from "../lens-selection.js";
import { documentText } from "./document-text.js";
import { documentSchema } from "./document.js";
import type { Snapshot } from "./store.js";

const source = {
  side: "head" as const,
  file: "src/save.ts",
  fromLine: 10,
  toLine: 20,
};

const snapshot: Snapshot = {
  sessionId: "review-1",
  version: 2,
  title: "Save flow",
  createdAt: "today",
  pins: { repositoryId: "repo", base: "before", head: "after" },
  target: {
    kind: "commits",
    repositoryId: "repo",
    base: "before",
    head: "after",
  },
  document: documentSchema.parse([
    {
      id: "section-1",
      type: "section",
      title: "Storage",
      children: [
        {
          id: "markdown-2",
          type: "markdown",
          markdown:
            "First paragraph.\n\nThe complete explanation, including [source](review-source:head/src/save.ts#L10-L20).",
        },
        {
          id: "callout-3",
          type: "callout",
          tone: "warning",
          children: [
            {
              id: "code-4",
              type: "code",
              language: "ts",
              text: "save();\nnotify();",
              caption: "Save before notifying",
            },
          ],
        },
      ],
    },
    {
      id: "sequence-5",
      type: "sequence",
      title: "Save",
      actors: { client: "Client", server: "Server" },
      steps: [
        {
          id: "step-6",
          from: "client",
          to: "server",
          label: "Submit",
          explanation: "Validate before saving.",
        },
        {
          id: "step-7",
          from: "server",
          to: "client",
          label: "Result",
          style: "return",
          code: { language: "json", text: "true" },
        },
      ],
    },
    {
      id: "peek-8",
      type: "code_peek",
      source: selectSource(source),
      caption: "The save function",
    },
    {
      id: "stack-9",
      type: "call_stack_diff",
      title: "Callers",
      base: [],
      head: [
        {
          source: selectSource(source),
          label: "New caller",
          via: { kind: "queue", reason: "Background work" },
        },
      ],
    },
    {
      id: "db-10",
      type: "database_lens",
      title: "Persistence",
      actors: { server: "Server" },
      stores: {
        db: {
          label: "Database",
          storage: "relational",
          collections: {
            reviews: {
              label: "Reviews",
              fields: {
                owner: {
                  label: "Owner",
                  dataType: "text",
                  nullable: true,
                  references: { store: "db", collection: "users", field: "id" },
                },
              },
            },
          },
        },
      },
      useCases: [
        {
          label: "Save review",
          summary: "Keep the new content",
          operations: [
            {
              kind: "write",
              store: "db",
              collection: "reviews",
              actor: "server",
              label: "Store snapshot",
              source: selectSource(source),
            },
          ],
        },
      ],
    },
    {
      id: "image-11",
      type: "image",
      assetId: "asset-1",
      alt: "Screen layout",
      caption: "After saving",
    },
    {
      id: "quote-12",
      type: "trace_quote",
      traceId: "trace-1",
      eventId: "event-1",
      text: "Saved successfully",
    },
    {
      id: "map-13",
      type: "software_map",
      mapVersionId: "map-1",
      focusElementId: "storage",
    },
    { id: "divider-14", type: "divider" },
  ]),
};

it("reads all component kinds without losing prose, relationships or source locations", () => {
  const text = documentText(snapshot, undefined, true);

  for (const content of [
    "complete explanation",
    "review-source:head/src/save.ts#L10-L20",
    "save();",
    "notify();",
    "client → server: Submit",
    "Validate before saving.",
    "Result (return)",
    "head/src/save.ts:10-20",
    "New caller",
    "Background work",
    "Owner, text, nullable → db.users.id",
    "Store snapshot",
    "Keep the new content",
    "Screen layout",
    "asset-1",
    "trace-1, event event-1",
    "Saved successfully",
    "map-1, focus: storage",
    "[divider-14]",
  ]) {
    expect(text).toContain(content);
  }

  // Indentation preserves containment; reading IDs are the saved edit targets.
  expect(text).toMatch(
    /\[section-1\][\s\S]*\n  \[callout-3\][\s\S]*\n    \[code-4\]/,
  );
});

it("offers a shorter outline, complete target reads, and rejects missing IDs", () => {
  expect(documentText(snapshot)).not.toContain("complete explanation");
  const target = documentText(snapshot, "markdown-2");
  expect(target).toContain("complete explanation");
  expect(target).not.toContain("[sequence-5]");
  expect(documentText(snapshot, "section-1")).toContain("notify();");
  expect(() => documentText(snapshot, "missing")).toThrow("Target not found");
  expect(documentText({ ...snapshot, document: [] })).toContain("Empty review");
});
