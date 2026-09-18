/** Three reviews over two worktrees: Home groups them by worktree, filters and
 *  lists them, opens them as separate tabs, and its dismiss / restore / delete
 *  actions reach the store. */
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

/** Every locator this journey uses, taken from the current `ctx.page`.
 *  `openHome` falls back to `restartDesktop`, which replaces the page, so
 *  locators are rebuilt after each return to Home rather than bound once. */
function homeUi(ctx) {
  const home = ctx.page.locator("main.review-home");

  return {
    home,
    cards: home.locator(".review-home-card"),
    rows: home.locator(".review-home-list-row"),
    tabs: ctx.page.locator(".tabs-container .tab"),
    // One canvas part renders whichever review tab is active, so the heading is
    // what says which review the reader is on.
    canvas: ctx.page.locator(".review-canvas-root [data-review-api]"),
  };
}

/** The review ids the store lists. `apiOk` is what keeps "the deleted review is
 *  gone" from passing on an error body. */
async function listedReviewIds(ctx) {
  return (await ctx.apiOk("/reviews-api")).map((summary) => summary.reviewId);
}

export async function run(ctx) {
  const { git, root, until } = ctx;

  const first = await createReview(ctx, {
    title: "Order review",
    blocks: orderReviewBlocks,
  });

  const second = await createReview(ctx, {
    title: "Second review",
    blocks: [
      { type: "markdown", markdown: "Second look at the same change." },
    ],
  });

  // A second worktree of the same repository: Home groups by checkout, not by
  // repository, so this is what makes two groups out of three reviews.
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

  await home.locator('[aria-label="Search reviews"]').fill("Worktree B");
  await until(async () => (await cards.count()) === 1, "search narrows to one card");

  // The list view replaces the cards with table rows, so the same three
  // reviews are `rows` (`.review-home-list-row`) here, not `cards`; the brief's
  // card count would have read 0 in every list-view assertion.
  await home.locator('[aria-label="List view"]').click();
  await until(
    async () => (await home.getAttribute("data-view")) === "list",
    "the list view",
  );
  await until(async () => (await rows.count()) === 1, "one row under the search");
  await home.locator('[aria-label="Clear search"]').click();
  await until(async () => (await rows.count()) === 3, "clear restores three rows");
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
  await pickReview(ctx, first.reviewId);
  await canvas.getByRole("heading", { name: first.title }).waitFor();
  ctx.check(
    "two reviews open as separate tabs and app pick switches between them",
  );

  await openHome(ctx);
  ({ home, cards } = homeUi(ctx));

  // The dismiss button is a sibling of the card button inside the shell, not a
  // descendant of `.review-home-card` (`review-home-view.tsx:477-493`).
  const shellB = home
    .locator(".review-home-card-shell")
    .filter({ hasText: third.title });

  const dismissedRow = home
    .locator(".review-home-dismissed-row")
    .filter({ hasText: third.title });

  // Dismissed rows are behind a disclosure that starts collapsed and keeps its
  // state across re-renders, so only open it when it is shut.
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

  // Delete is offered only on a dismissed review, in its Dismissed row
  // (`review-home-view.tsx:393-396`), so the permanent action always follows
  // the reversible one; the brief looked for it on the card.
  await dismiss();
  await expandDismissed();
  assert.ok(
    (await listedReviewIds(ctx)).includes(third.reviewId),
    `${third.reviewId} is not listed before the delete`,
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
    !remaining.includes(third.reviewId),
    `${third.reviewId} is still listed after deletion`,
  );
  assert.deepEqual(
    [first.reviewId, second.reviewId].filter((id) => !remaining.includes(id)),
    [],
    "deleting one review must not unlist the others",
  );
  ctx.check("dismiss, restore and two-click delete update Home and the store");
}
