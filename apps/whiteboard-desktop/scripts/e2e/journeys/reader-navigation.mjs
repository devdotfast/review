/** One reader's path through a review: every view, the Find widget, the table of contents, and the version a rename seals. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createWhiteboard, orderWhiteboardBlocks } from "../harness.mjs";

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
const longSection = (title) => ({
  type: "section",
  title,
  children: Array.from({ length: 10 }, () => ({
    type: "markdown",
    markdown: PARAGRAPH,
  })),
});

export async function run(ctx) {
  const { until } = ctx;

  // The contents need more than two headings and an entry below the fold, so two long sections are added.
  const review = await createWhiteboard(ctx, {
    title: TITLE,
    blocks: [
      ...orderWhiteboardBlocks,
      longSection("Rollout"),
      longSection("Risks"),
    ],
  });

  // Resolve the canvas window again: the fresh profile's workbench reload can replace the page between helpers.
  const page = await ctx.apiCanvasFor(TITLE);

  await ctx.watchPage(page);

  const canvas = page.locator(".whiteboard-canvas-root [data-whiteboard-api]");

  const views = page.locator('[aria-label="Session views"]');

  const viewLabels = () =>
    views
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      );

  const traces = await ctx.apiOk(
    `/sessions-api/${review.sessionId}/agent-traces`,
  );

  assert.ok(
    Array.isArray(traces.sessions),
    `agent-traces listed no sessions: ${JSON.stringify(traces)}`,
  );

  // A two-commit range offers Commits and Diff, Map needs a software map this review has none of, Trace needs traces.
  const offered = [
    "Session",
    "Commits",
    "Diff",
    ...(traces.sessions.length > 0 ? ["Trace"] : []),
  ];

  await until(
    async () => (await viewLabels()).join(", ") === offered.join(", "),
    `the review views to settle on ${offered.join(", ")}`,
  );

  // Review goes last so the reader ends on the document the rest of the journey reads.
  for (const label of [...offered.slice(1), "Session"]) {
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
    (await find.locator(".whiteboard-find-count").innerText()).trim();

  await page.keyboard.press("Meta+F");
  await find.waitFor();
  await input.fill("stat");

  const plain = await until(async () => {
    const text = await countText();

    return /^\d+ of \d+$/.test(text) ? text : null;
  }, "a plain-text match count");

  const wholeWord = find.locator(".whiteboard-find-toggle--whole-word");

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

  await find.locator(".whiteboard-find-toggle--regex").click();
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

  const toc = page.locator("nav#whiteboard-toc");

  await toc.waitFor();

  const isDrawerOpen = async () =>
    (await toc.getAttribute("class")).includes("whiteboard-toc--open");

  // The contents are an open rail only at the top of a wide shell; otherwise a shut drawer is `pointer-events: none`.
  if (!(await isDrawerOpen())) await page.locator(".whiteboard-toc-toggle").click();
  await until(isDrawerOpen, "the contents drawer to open");

  // Entries are buttons, not links with an `href`, so the target is found by its heading text.
  const links = toc.locator(".whiteboard-toc-link");

  assert.deepEqual(
    (await links.locator(".whiteboard-toc-text").allInnerTexts()).map((text) =>
      text.trim(),
    ),
    ["Overview", "Rollout", "Risks"],
    "the contents must list every section of the review",
  );

  const target = canvas.getByRole("heading", { name: "Risks", exact: true });

  const region = page.locator(".whiteboard-view-region--review");

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
  await links.last().click();
  await until(async () => {
    const value = await offset();

    return value !== null && value >= -8 && value < 120;
  }, "Risks to scroll to the top of the review");
  ctx.check("table of contents navigates");

  const history = () => ctx.apiOk(`/sessions-api/${review.sessionId}/history`);

  const before = await history();

  const renamed = await ctx.api("/sessions-api/commands", "POST", {
    commandId: randomUUID(),
    operation: { type: "rename", sessionId: review.sessionId, title: RENAMED },
  });

  assert.equal(renamed.status, 200, JSON.stringify(renamed.value));

  const after = await history();

  // Every command seals a version, so the rename alone gives the history control a previous revision to open.
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

  await canvas.getByRole("heading", { name: RENAMED, exact: true }).waitFor();
  await page.locator('button[aria-label="Version history"]').click();

  const items = page.locator('ul[role="menu"] [role="menuitem"]');

  await until(
    async () => (await items.count()) === after.length,
    `the version menu to list all ${after.length} versions`,
  );

  const previous = items.nth(after.length - 2);

  assert.match(
    await previous.innerText(),
    new RegExp(`^Version ${after.at(-2).version} `),
    "the second-to-last menu item is not the version before the rename",
  );
  await previous.click();

  const banner = page.locator('.whiteboard-history-banner[role="status"]');

  await banner
    .getByText("You are viewing an older version of this review.")
    .waitFor();
  await canvas.getByRole("heading", { name: TITLE, exact: true }).waitFor();
  await canvas
    .getByRole("heading", { name: "Overview", exact: true })
    .waitFor();
  await banner.getByRole("button", { name: "Back to latest" }).click();
  await banner.waitFor({ state: "hidden" });
  await canvas.getByRole("heading", { name: RENAMED, exact: true }).waitFor();
  ctx.check("version history opens the previous revision");
}
