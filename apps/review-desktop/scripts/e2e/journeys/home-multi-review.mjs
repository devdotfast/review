/** Three reviews over two worktrees: Home groups, filters and opens them, and dismiss / restore / delete reach the store. */
import assert from "node:assert/strict";
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
    cards: home.locator(".review-home-card"),
    rows: home.locator(".review-home-list-row"),
    tabs: ctx.page.locator(".tabs-container .tab"),
    // One canvas part renders whichever review tab is active, so the heading says which review the reader is on.
    canvas: ctx.page.locator(".review-canvas-root [data-review-api]"),
  };
}

/** The review ids the store lists; `apiOk` keeps "the deleted review is gone" from passing on an error body. */
async function listedReviewIds(ctx) {
  return (await ctx.apiOk("/sessions-api")).map((summary) => summary.sessionId);
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

  // Home groups by checkout, not by repository, so a second worktree makes two groups out of three reviews.
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

  await openHome(ctx);

  let { home, cards, rows, tabs, canvas } = homeUi(ctx);

  await until(
    async () => (await home.locator(".review-home-workspace").count()) === 2,
    "two workspace groups",
  );
  await until(async () => {
    const seen = await cards.count();

    assert.equal(seen, 3, `saw ${seen}`);

    return true;
  }, "three review cards");
  ctx.check("Home groups three reviews under two worktrees");

  await home.locator('[aria-label="Search sessions"]').fill("Worktree B");
  await until(
    async () => (await cards.count()) === 1,
    "search narrows to one card",
  );

  // The list view replaces the cards with `.review-home-list-row`, so the same reviews are counted as rows here.
  await home.locator('[aria-label="List view"]').click();
  await until(
    async () => (await home.getAttribute("data-view")) === "list",
    "the list view",
  );
  await until(
    async () => (await rows.count()) === 1,
    "one row under the search",
  );
  await home.locator('[aria-label="Clear search"]').click();
  await until(
    async () => (await rows.count()) === 3,
    "clear restores three rows",
  );
  await home.locator('[aria-label="Card view"]').click();
  await until(
    async () => (await home.getAttribute("data-view")) === "cards",
    "the card view",
  );
  await until(async () => (await cards.count()) === 3, "clear restores three");
  ctx.check("Home search, list view and clear behave");

  for (const title of [first.title, second.title, third.title])
    assert.equal(
      await tabs.filter({ hasText: title }).count(),
      1,
      `one editor tab for ${title}`,
    );

  await cards.filter({ hasText: second.title }).click();
  await canvas.getByRole("heading", { name: second.title }).waitFor();
  await pickReview(ctx, first.sessionId);
  await canvas.getByRole("heading", { name: first.title }).waitFor();
  ctx.check(
    "two reviews open as separate tabs and app pick switches between them",
  );

  await openHome(ctx);
  ({ home, cards } = homeUi(ctx));

  // The dismiss button is a sibling of the card button inside the shell, not a descendant of `.review-home-card`.
  const shellB = home
    .locator(".review-home-card-shell")
    .filter({ hasText: third.title });

  const dismissedRow = home
    .locator(".review-home-dismissed-row")
    .filter({ hasText: third.title });

  // Dismissed rows sit behind a disclosure that keeps its state across re-renders, so only open it when it is shut.
  const expandDismissed = async () => {
    const toggle = home.locator(".review-home-dismissed-toggle");

    await toggle.waitFor();

    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
    await dismissedRow.waitFor();
  };

  const dismiss = async () => {
    await shellB.hover();
    await shellB.locator('[title="Dismiss review"]').click();
    await home.locator('section[aria-label="Dismissed reviews"]').waitFor();
  };

  await dismiss();
  await until(
    async () => (await cards.count()) === 2,
    "the dismissed review leaves the cards",
  );
  await expandDismissed();
  await dismissedRow.locator(".review-home-restore").click();
  await until(async () => (await cards.count()) === 3, "restored");

  // Delete is offered only in a dismissed review's row, so the permanent action always follows the reversible one.
  await dismiss();
  await expandDismissed();
  assert.ok(
    (await listedReviewIds(ctx)).includes(third.sessionId),
    `${third.sessionId} is not listed before the delete`,
  );
  await dismissedRow.locator('[title="Delete review"]').click();
  await dismissedRow.locator('[title="Click again to delete"]').click();
  await until(
    async () => (await dismissedRow.count()) === 0,
    "the deleted review leaves Home",
  );
  await until(async () => {
    const seen = await cards.count();

    assert.equal(seen, 2, `saw ${seen}`);

    return true;
  }, "two review cards after the delete");

  const remaining = await listedReviewIds(ctx);

  assert.ok(
    !remaining.includes(third.sessionId),
    `${third.sessionId} is still listed after deletion`,
  );
  assert.deepEqual(
    [first.sessionId, second.sessionId].filter((id) => !remaining.includes(id)),
    [],
    "deleting one review must not unlist the others",
  );
  ctx.check("dismiss, restore and two-click delete update Home and the store");
}
