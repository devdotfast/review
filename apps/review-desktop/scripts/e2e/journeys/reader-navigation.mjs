/** One reader's path through a review: every view, the Find widget, the table of contents, and the version a rename seals. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  PRIMARY_MODIFIER,
  createReview,
  orderReviewBlocks,
} from "../harness.mjs";

export const name = "reader-navigation";

export const phase = 1;

export const options = {};

const TITLE = "Order review";

const RENAMED = "Order review v2";

/** Prose whose every "stat" sits inside "status", which is what makes the whole-word search a real test. */
const PARAGRAPH =
  "The queue worker reads each order once, writes the new value and " +
  "acknowledges the message only after the write lands, so a retry can never " +
  "apply the same change twice.";

/** A section long enough to push whatever follows it below the fold. */
const longSection = (title, paragraphs = 10) => ({
  type: "section",
  title,
  children: Array.from({ length: paragraphs }, () => ({
    type: "markdown",
    markdown: PARAGRAPH,
  })),
});

export async function run(ctx) {
  const { until } = ctx;

  // The contents need more than two headings and an entry below the fold; a tall trailing section lets that entry
  // reach the top of the region however tall the window is.
  const review = await createReview(ctx, {
    title: TITLE,
    blocks: [
      ...orderReviewBlocks,
      longSection("Rollout"),
      longSection("Risks"),
      longSection("Follow-up", 40),
    ],
  });

  // Resolve the canvas window again: the fresh profile's workbench reload can replace the page between helpers.
  const page = await ctx.apiCanvasFor(TITLE);

  await ctx.watchPage(page);

  const canvas = page.locator(".review-canvas-root [data-review-api]");

  const views = page.locator('[aria-label="Session views"]');

  const viewLabels = () =>
    views
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );

  const traces = await ctx.apiOk(
    `/reviews-api/${review.reviewId}/agent-traces`,
  );

  assert.ok(
    Array.isArray(traces.sessions),
    `agent-traces listed no sessions: ${JSON.stringify(traces)}`,
  );

  // A two-commit range offers Commits and Diff, Map needs a software map this review has none of, Trace needs traces.
  const offered = [
    "Whiteboard",
    "Commits",
    "Diff",
    ...(traces.sessions.length > 0 ? ["Trace"] : []),
  ];

  await until(
    async () => (await viewLabels()).join(", ") === offered.join(", "),
    `the review views to settle on ${offered.join(", ")}`,
  );

  // Whiteboard goes last so the reader ends on the document the rest of the journey reads.
  for (const label of [...offered.slice(1), "Whiteboard"]) {
    const button = views.locator(`button[aria-label="${label}"]`);

    await button.click();
    await until(
      async () => (await button.getAttribute("aria-pressed")) === "true",
      `the ${label} view to activate`,
    );
  }

  ctx.check("all offered review views activate");

  const find = page.locator('[role="search"][aria-label="Find in session"]');

  const input = find.locator('[aria-label="Find"]');

  const countText = async () =>
    (await find.locator(".review-find-count").innerText()).trim();

  // The peek's source is searchable too, so Find starts once it has rendered.
  await canvas.locator(".review-inline-editor .view-line").first().waitFor();
  await page.keyboard.press(`${PRIMARY_MODIFIER}+KeyF`);
  await find.waitFor();
  await input.fill("stat");

  // The code peek's matches join the count once its editor has rendered, so only a count that holds still is read.
  const plain = await until(async () => {
    const text = await countText();

    await page.waitForTimeout(1000);

    return /^\d+ of \d+$/.test(text) && (await countText()) === text
      ? text
      : null;
  }, "a settled plain-text match count");

  const wholeWord = find.locator(".review-find-toggle--whole-word");

  await wholeWord.click();
  await until(
    async () => (await wholeWord.getAttribute("aria-pressed")) === "true",
    "the whole-word toggle to turn on",
  );
  await until(
    async () => (await countText()) === "No results",
    'whole-word "stat" to match nothing',
  );
  await wholeWord.click();
  await until(
    async () => (await countText()) === plain,
    `the plain count (${plain}) to come back`,
  );

  await find.locator(".review-find-toggle--regex").click();
  await input.fill("stat(");
  // An uncompilable pattern reads "Invalid expression" in the count and marks the input.
  await until(
    async () => (await countText()) === "Invalid expression",
    "the invalid regular expression to be reported",
  );
  assert.equal(
    await input.getAttribute("aria-invalid"),
    "true",
    "the Find input is not marked invalid",
  );

  await input.fill("stat.s");

  const total = Number(
    await until(
      async () => /^1 of (\d+)$/.exec(await countText())?.[1],
      "the regular expression to match from the first hit",
    ),
  );

  assert.ok(
    total >= 2,
    `the wrap needs at least two matches, the regex found ${total}`,
  );

  // One Enter per match walks the whole list and lands back on the first.
  for (let step = 1; step <= total; step++) {
    const expected = `${(step % total) + 1} of ${total}`;

    await input.press("Enter");
    await until(
      async () => (await countText()) === expected,
      `Enter to reach ${expected}`,
    );
  }

  await input.press("Escape");
  await find.waitFor({ state: "hidden" });
  ctx.check(
    "find handles plain, whole-word, regex and invalid regex, and wraps",
  );

  const toc = page.locator("nav#review-toc");

  await toc.waitFor();

  const isDrawerOpen = async () =>
    (await toc.getAttribute("class")).includes("review-toc--open");

  // The contents are an open rail only at the top of a wide shell; otherwise a shut drawer is `pointer-events: none`.
  if (!(await isDrawerOpen())) await page.locator(".review-toc-toggle").click();
  await until(isDrawerOpen, "the contents drawer to open");

  // Entries are buttons, not links with an `href`, so the target is found by its heading text.
  const links = toc.locator(".review-toc-link");

  assert.deepEqual(
    (await links.locator(".review-toc-text").allInnerTexts()).map((text) =>
      text.trim(),
    ),
    ["Overview", "Rollout", "Risks", "Follow-up"],
    "the contents must list every section of the review",
  );

  const target = canvas.getByRole("heading", { name: "Risks", exact: true });

  const region = page.locator(".review-view-region--review");

  /** How far the target heading sits below the top of the scrolling region. */
  const offset = async () => {
    const [heading, view] = await Promise.all([
      target.boundingBox(),
      region.boundingBox(),
    ]);

    return heading && view ? heading.y - view.y : null;
  };

  const beforeClick = await offset();

  assert.ok(
    beforeClick > 200,
    `Risks starts ${beforeClick}px into the region, too near the top for ` +
      "the scroll to prove anything",
  );
  await links.filter({ hasText: "Risks" }).click();
  await until(async () => {
    const value = await offset();

    return value !== null && value >= -8 && value < 120;
  }, "Risks to scroll to the top of the review");
  ctx.check("table of contents navigates");

  const history = () => ctx.apiOk(`/reviews-api/${review.reviewId}/history`);

  const before = await history();

  const renamed = await ctx.api("/reviews-api/commands", "POST", {
    commandId: randomUUID(),
    operation: { type: "rename", reviewId: review.reviewId, title: RENAMED },
  });

  assert.equal(renamed.status, 200, JSON.stringify(renamed.value));

  const after = await history();

  // Every command seals a version, so the rename alone leaves exactly one previous revision behind.
  assert.equal(
    after.length,
    before.length + 1,
    "the rename did not seal a new version",
  );
  assert.equal(
    after.at(-1).title,
    RENAMED,
    "the newest version kept the old title",
  );
  assert.equal(
    after.at(-2).title,
    TITLE,
    "the version before the rename must keep the original title",
  );

  // The version picker left the topbar in #389, so no reader control opens an older revision; the history is API-only.
  await canvas.getByRole("heading", { name: RENAMED, exact: true }).waitFor();
  ctx.check("a rename seals a new version and the open canvas shows it");
}
