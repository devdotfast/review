/** The JSON review API must reject the pitfalls the old render gate caught, and an accepted edit must render live. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createReview, orderReviewBlocks } from "../harness.mjs";
import {
  openLegacyReview,
  seedLegacyFixtures,
  waitForImport,
} from "../legacy-fixtures.mjs";

export const name = "json-api-edit";

export const phase = 1;

export const options = { beforeLaunch: seedLegacyFixtures };

export async function run(ctx) {
  const { api, apiOk, apiCanvasFor, legacyFixtures } = ctx;

  // createReview has not run yet, so an imported fixture is the only open canvas available.
  const fixture = legacyFixtures.find(
    (candidate) => candidate.metadata.sourceRepository === "devdotfast/review",
  );

  assert.ok(fixture, "an importable legacy fixture is available");

  const { metadata } = fixture;

  await waitForImport(ctx, metadata.sourceUuid);
  await openLegacyReview(ctx, fixture);
  const snapshot = await waitForImport(ctx, metadata.sourceUuid);

  const page = await apiCanvasFor(snapshot.title);

  await ctx.watchPage(page);

  const canvas = page.locator(".review-canvas-root");

  const before = await apiOk(`/sessions-api/${metadata.sourceUuid}?full=true`);

  const edit = (content) =>
    api("/sessions-api/commands", "POST", {
      commandId: randomUUID(),
      operation: {
        type: "edit",
        reviewId: metadata.sourceUuid,
        edit: { type: "insert", content },
      },
    });

  for (const [content, message] of [
    [
      {
        type: "database_lens",
        title: "Empty",
        actors: { app: "App" },
        stores: {},
        useCases: [],
      },
      "at least one store",
    ],
    [
      {
        type: "sequence",
        title: "Save",
        actors: { app: "App" },
        steps: [{ from: "app", to: "db", label: "Write", explanation: "x" }],
      },
      "Unknown component name: db",
    ],
    [
      {
        type: "code_peek",
        source: {
          side: "head",
          file: "../outside.ts",
          fromLine: 1,
          toLine: 1,
        },
      },
      "repository-relative",
    ],
  ]) {
    const rejected = await edit(content);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.value));
    assert.match(rejected.value.error, new RegExp(message));
  }

  const after = await apiOk(`/sessions-api/${metadata.sourceUuid}?full=true`);

  assert.deepEqual(
    after,
    before,
    "rejected edits must not change the document",
  );

  const accepted = await edit({
    type: "callout",
    title: "E2E marker",
    tone: "success",
    children: [
      { type: "markdown", markdown: "Inserted through the JSON API." },
    ],
  });

  assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
  await canvas
    .getByText("Inserted through the JSON API.", { exact: true })
    .waitFor();
  assert.doesNotMatch(await canvas.innerText(), /Layout failed:/);
  ctx.check(
    "JSON API rejects lens, actor and path pitfalls without changing the document",
    "JSON API edits render live in the open canvas",
  );

  // The same API path the later journeys use to author their own reviews.
  const created = await createReview(ctx, {
    title: "Order status e2e",
    blocks: orderReviewBlocks,
  });

  await created.canvas
    .getByRole("heading", { name: "Overview", exact: true })
    .waitFor();
  await created.canvas
    .getByText("moves from draft to queued")
    .first()
    .waitFor();
  assert.doesNotMatch(await created.canvas.innerText(), /Layout failed:/);
  ctx.check("createReview helper opens an API review");
}
