import { createHash, randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import {
  type ReviewLiveMutation,
  ReviewLiveMutationSchema,
  parseLiveDocument,
  planLiveMutation,
} from "./review-live-document";

const reviewUuid = randomUUID();
function edit(
  source: string | null,
  operation: ReviewLiveMutation["operation"],
) {
  const current = {
    source,
    sourceHash:
      source === null
        ? null
        : createHash("sha256").update(source).digest("hex"),
  };
  const request = ReviewLiveMutationSchema.parse({
    reviewUuid,
    mutationId: randomUUID(),
    expectedSourceHash: current.sourceHash,
    operation,
  });
  return { current, request, source: planLiveMutation(current, request) };
}

it("preserves arbitrary rich MDX while inserting, updating, moving, and deleting stable nodes", () => {
  const initial = edit("# Old document", {
    type: "replace",
    nodes: [
      { id: "title", source: "# Live review" },
      {
        id: "diagram",
        source:
          "<SequenceDiagram {...data.sequence} />\n\n<section>Nested prose</section>",
      },
    ],
  });
  const inserted = edit(initial.source, {
    type: "insert",
    afterId: "title",
    node: { id: "intro", source: "Hello" },
  });
  const updated = edit(inserted.source, {
    type: "update",
    node: { id: "intro", source: "New prose" },
  });
  const moved = edit(updated.source, {
    type: "move",
    id: "diagram",
    afterId: null,
  });
  const deleted = edit(moved.source, { type: "delete", id: "title" });
  expect(parseLiveDocument(deleted.source)).toMatchObject({
    revision: 5,
    nodes: [
      {
        id: "diagram",
        source:
          "<SequenceDiagram {...data.sequence} />\n\n<section>Nested prose</section>",
      },
      { id: "intro", source: "New prose" },
    ],
  });
  expect(
    planLiveMutation(
      { source: initial.source, sourceHash: "new-hash" },
      initial.request,
    ),
  ).toBe(initial.source);
  expect(() =>
    planLiveMutation(
      { source: initial.source, sourceHash: "new-hash" },
      { ...initial.request, operation: { type: "replace", nodes: [] } },
    ),
  ).toThrow("already used");
  expect(() =>
    planLiveMutation(
      { source: deleted.source, sourceHash: "latest" },
      updated.request,
    ),
  ).toThrow("source changed");
});

it("requires explicit conversion, validates identifiers, and refuses ambiguous node boundaries", () => {
  expect(() =>
    edit("# Old", {
      type: "insert",
      afterId: null,
      node: { id: "new", source: "Hello" },
    }),
  ).toThrow("explicitly start");
  expect(() =>
    edit(null, { type: "replace", nodes: [{ id: "bad/id", source: "Hello" }] }),
  ).toThrow("Invalid string");
  expect(() =>
    edit(null, {
      type: "replace",
      nodes: [{ id: "ok", source: "{/* review-live/end */}" }],
    }),
  ).toThrow("reserved");
  const live = edit(null, {
    type: "replace",
    nodes: [{ id: "one", source: "Hello" }],
  }).source;
  expect(() => parseLiveDocument(live + "extra")).toThrow("structure changed");
  expect(() =>
    edit(live, {
      type: "insert",
      afterId: "missing",
      node: { id: "two", source: "Hi" },
    }),
  ).toThrow("Unknown");
  expect(() => edit(live, { type: "move", id: "one", afterId: "one" })).toThrow(
    "itself",
  );
  expect(() =>
    edit(live, {
      type: "insert",
      afterId: null,
      node: { id: "one", source: "Hi" },
    }),
  ).toThrow("already exists");
});
