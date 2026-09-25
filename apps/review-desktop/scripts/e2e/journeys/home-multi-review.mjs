/** Three reviews over two worktrees: Home lists, filters and opens them, and dismiss / restore / delete reach the store. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createReview,
  openHome,
  orderReviewBlocks,
  pickReview,
} from "../harness.mjs";

export const name = "home-multi-review";

export const phase = 1;

export const options = {};

/** Every locator this journey uses, rebuilt from the current `ctx.page` after each return to Home. */
function homeUi(ctx) {
  const home = ctx.page.locator("main.review-home");

  return {
    home,
    // Home lists active sessions as table rows; each row's title button is what opens it.
    rows: home.locator(".review-home-table-open"),
    tabs: ctx.page.locator(".tabs-container .tab"),
    // One canvas part renders whichever review tab is active, so the heading says which review the reader is on.
    canvas: ctx.page.locator(".review-canvas-root [data-review-api]"),
  };
}

/** The review ids the store lists; `apiOk` keeps "the deleted review is gone" from passing on an error body. */
async function listedReviewIds(ctx) {
  return (await ctx.apiOk("/reviews-api")).map((summary) => summary.reviewId);
}

/** Home offers no dismissal for an active session once delete is available, so dismissal goes through the store. */
async function setAttention(ctx, reviewId, action) {
  await ctx.apiOk("/reviews-api/commands", "POST", {
    commandId: randomUUID(),
    operation: { type: "attention", reviewId, action },
  });
}

export async function run(ctx) {
  const { git, root, until } = ctx;

  const first = await createReview(ctx, {
    title: "Order review",
    blocks: orderReviewBlocks,
  });

  const second = await createReview(ctx, {
    title: "Second review",
    blocks: [{ type: "markdown", markdown: "Second look at the same change." }],
  });

  // A second worktree of the same repository, so Home lists reviews from two checkouts.
  const other = path.join(root, "repo-b");

  await git("worktree", "add", "-q", "-b", "feature-b", other, ctx.head);
  await writeFile(
    path.join(other, "order.ts"),
    'export const status = "shipped";\n',
  );
  await git("-C", other, "commit", "-qam", "Ship");

  const headB = await git("-C", other, "rev-parse", "HEAD");

  const third = await createReview(ctx, {
    title: "Worktree B review",
    repoPath: other,
    base: ctx.head,
    head: headB,
    blocks: [{ type: "markdown", markdown: "Shipped." }],
  });

  const titles = [first.title, second.title, third.title];

  await openHome(ctx);

  let { home, rows, tabs, canvas } = homeUi(ctx);

  const rowTitles = async () =>
    (await rows.locator(".review-home-review-title").allInnerTexts())
      .map((text) => text.trim())
      .sort();

  await until(
    async () =>
      JSON.stringify(await rowTitles()) === JSON.stringify([...titles].sort()),
    "Home to list all three reviews",
  );
  ctx.check("Home lists three reviews from two worktrees");

  const search = home.getByRole("searchbox", { name: "Search sessions" });

  await search.fill("Worktree B");
  await until(
    async () =>
      JSON.stringify(await rowTitles()) === JSON.stringify([third.title]),
    "search to narrow Home to the worktree B review",
  );
  await home.getByRole("button", { name: "Clear search" }).click();
  await until(
    async () => (await rows.count()) === 3,
    "clear restores three rows",
  );
  assert.equal(await search.inputValue(), "", "clear left text in the search");
  ctx.check("Home search narrows the list and clear restores it");

  for (const title of titles)
    assert.equal(
      await tabs.filter({ hasText: title }).count(),
      1,
      `one editor tab for ${title}`,
    );

  await rows.filter({ hasText: second.title }).click();
  await canvas.getByRole("heading", { name: second.title }).waitFor();
  await pickReview(ctx, first.reviewId);
  await canvas.getByRole("heading", { name: first.title }).waitFor();
  ctx.check(
    "two reviews open as separate tabs and app pick switches between them",
  );

  await openHome(ctx);
  ({ home, rows } = homeUi(ctx));

  const dismissedRow = home
    .locator(".review-home-dismissed-row")
    .filter({ hasText: third.title });

  await setAttention(ctx, third.reviewId, "dismiss");
  await until(
    async () => (await rows.count()) === 2,
    "the dismissed review to leave the active list",
  );

  // Dismissed rows sit behind a disclosure that keeps its state across re-renders, so only open it when it is shut.
  const toggle = home.locator(".review-home-dismissed-toggle");

  await toggle.waitFor();

  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await dismissedRow.getByRole("button", { name: "Undo", exact: true }).click();
  await until(
    async () => (await rows.count()) === 3,
    "Undo to restore the review",
  );
  await dismissedRow.waitFor({ state: "detached" });
  ctx.check("a dismissed review waits under Dismissed and Undo restores it");

  assert.ok(
    (await listedReviewIds(ctx)).includes(third.reviewId),
    `${third.reviewId} is not listed before the delete`,
  );

  // An active row's only action is delete, behind its menu and a second, confirming click.
  await home
    .getByRole("button", { name: `Actions for ${third.title}`, exact: true })
    .click();

  const menu = home.getByRole("menu", { name: "Session actions" });

  await menu
    .getByRole("menuitem", { name: `Delete ${third.title}`, exact: true })
    .click();
  await menu
    .getByRole("menuitem", {
      name: `Confirm delete ${third.title}`,
      exact: true,
    })
    .click();
  await until(async () => {
    const seen = await rowTitles();

    assert.ok(seen.length >= 2, `saw ${seen.join(", ")}`);

    return (
      JSON.stringify(seen) ===
      JSON.stringify([first.title, second.title].sort())
    );
  }, "the deleted review to leave Home");

  const remaining = await listedReviewIds(ctx);

  assert.ok(
    !remaining.includes(third.reviewId),
    `${third.reviewId} is still listed after deletion`,
  );
  assert.deepEqual(
    [first.reviewId, second.reviewId].filter((id) => !remaining.includes(id)),
    [],
    "deleting one review must not unlist the others",
  );
  ctx.check("the row menu's two-click delete updates Home and the store");
}
