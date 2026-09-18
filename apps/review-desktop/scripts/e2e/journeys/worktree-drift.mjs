/** One review outliving its worktree: the working copy is dirtied, then the
 *  whole checkout is renamed, then deleted, and the review is re-read after
 *  every step. What the reader must never see is the working copy's bytes. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createReview,
  openHome,
  orderReviewBlocks,
  pickReview,
} from "../harness.mjs";

export const name = "worktree-drift";

export const phase = 1;

export const options = {};

const TITLE = "Order review";

const CANVAS_FAILURE = "ReviewApiError: Review operation failed.";

const BUG =
  "A review whose repository directory moves or is deleted renders " +
  "`ReviewApiError: Review operation failed.`";

/** Every locator this journey uses, taken from the current `ctx.page`: each
 *  `restartDesktop` replaces the page, so they are rebuilt rather than bound. */
function canvasUi(ctx) {
  const canvas = ctx.page.locator(".review-canvas-root [data-review-api]");

  return {
    heading: canvas.getByRole("heading", { name: TITLE, exact: true }),
    // `desktop-entry.tsx:42`, the state a missing checkout is meant to reach.
    unavailable: ctx.page.getByText("Worktree unavailable"),
    // `api-canvas.tsx:306`: the whole canvas replaced by one status line.
    failure: canvas.locator('p[role="status"]', { hasText: CANVAS_FAILURE }),
    peek: canvas
      .locator('.review-inline-editor[data-review-inline-editor="order.ts"]')
      .first(),
  };
}

/** Corroborates the canvas failure against the read that produces it before
 *  the journey is allowed to call it a known bug. */
async function assertCanvasFailureSignature(ctx, reviewId, where) {
  const { failure } = canvasUi(ctx);

  assert.equal(
    await failure.count(),
    1,
    `${where}: the canvas does not carry the logged failure line`,
  );

  // The document itself is still readable; only the source-backed read fails.
  const stored = await ctx.apiOk(`/reviews-api/${reviewId}?full=true`);

  assert.ok(
    stored.document.length > 0,
    `${where}: the stored document is empty, so the canvas error is not the logged bug`,
  );

  const commits = await ctx.api(
    `/reviews-api/${reviewId}/commits?version=${stored.version}`,
  );

  assert.equal(
    commits.status,
    500,
    `${where}: /commits answered ${commits.status} ${JSON.stringify(commits.value)}`,
  );
  assert.deepEqual(
    commits.value,
    { error: "Review operation failed." },
    `${where}: /commits failed with an unlogged body`,
  );
  await ctx.knownBug(BUG);
}

export async function run(ctx) {
  const { repo, until } = ctx;

  // The working copy is dirtied before the review exists, so the peek gets
  // exactly one chance to resolve and resolves against a tree that already
  // differs from the pinned head. Dirtying afterwards would let the assertion
  // pass by beating the first render rather than by reading pinned bytes.
  await writeFile(
    path.join(repo, "order.ts"),
    'export const status = "dirty";\n',
  );

  const review = await createReview(ctx, {
    title: TITLE,
    blocks: orderReviewBlocks,
  });

  const peekText = async () =>
    (await canvasUi(ctx).peek.locator(".view-line").allInnerTexts()).join("\n");

  await until(
    async () => (await peekText()).includes("queued"),
    "the peek to show the pinned head bytes",
  );
  assert.doesNotMatch(
    await peekText(),
    /dirty/,
    "the peek rendered the dirty working copy instead of the pinned head",
  );
  ctx.check("a dirty working copy does not change what the review shows");

  // `<gitCommonDir>/dev-fast/reviews/<uuid>/head/<sha>`
  // (`review-checkout-paths.ts:30-42`, `software-map-paths.ts:17-19`). It sits
  // inside the repository directory, so it travels with the rename below and
  // dies with the delete at the end.
  const commonDir = path.resolve(
    repo,
    await ctx.git("rev-parse", "--git-common-dir"),
  );

  const pinnedIn = (root) =>
    path.join(
      root,
      path.relative(repo, commonDir),
      "dev-fast/reviews",
      review.reviewId,
      "head",
      ctx.head,
    );

  assert.ok(
    existsSync(pinnedIn(repo)),
    `the peek resolved without a pinned checkout at ${pinnedIn(repo)}`,
  );

  // The control for everything below: the same restart and the same open, with
  // the repository still where it was registered. Without it, a canvas that
  // fails after the rename could be the restart's doing, and the "a moved
  // worktree breaks the review canvas" check would name the wrong cause.
  await ctx.restartDesktop();
  await pickReview(ctx, review.reviewId);

  const control = await canvasUi(ctx)
    .heading.waitFor({ timeout: 60000 })
    .then(
      () => null,
      (error) => error.message,
    );

  assert.equal(
    control,
    null,
    "a restart with the repository still in place must render the review; " +
      `without that control nothing below can blame the move: ${control}`,
  );

  const moved = `${repo}-moved`;

  await rename(repo, moved);
  assert.ok(
    existsSync(pinnedIn(moved)),
    `the rename did not carry the pinned checkout to ${pinnedIn(moved)}`,
  );
  await ctx.restartDesktop();
  await pickReview(ctx, review.reviewId, moved);

  const { heading, unavailable, failure } = canvasUi(ctx);

  // Three outcomes, two of them legitimate: the product names the checkout it
  // can no longer find, or it keeps rendering from the pinned checkout that
  // moved with the repository. The third is the logged failure. The check name
  // records which one this build took.
  const outcome = await until(
    async () =>
      ((await unavailable.count()) > 0 && "unavailable") ||
      ((await heading.count()) > 0 && "rendered") ||
      ((await failure.count()) > 0 && "failed"),
    "the moved worktree to report unavailable, render the pinned review, or fail",
  );

  if (outcome === "failed") {
    await assertCanvasFailureSignature(ctx, review.reviewId, "moved worktree");
    ctx.check("a moved worktree breaks the review canvas (known bug)");
  } else
    ctx.check(
      outcome === "unavailable"
        ? "a moved worktree is reported as unavailable"
        : "a moved worktree still renders from the pinned checkout",
    );

  const info = await ctx.cliRaw(
    ["info", "--review", review.reviewId, "--json"],
    moved,
  );

  if (info.code === 0) {
    assert.match(
      info.stdout,
      new RegExp(review.reviewId),
      `review info named no review: ${info.stdout}`,
    );
    ctx.check("info still resolves a review whose worktree moved");
  } else {
    // Only the logged bug may pass; any other failure is a new one.
    assert.match(
      `${info.stdout}${info.stderr}`,
      /"message":"Not found\."/,
      `review info: ${info.stdout}\n${info.stderr}`,
    );
    await ctx.knownBug(
      "`review info --review <uuid>` always fails with `Not found.`",
    );
    ctx.check("info cannot resolve a review whose worktree moved (known bug)");
  }

  await rm(moved, { recursive: true, force: true });
  assert.ok(
    !existsSync(pinnedIn(moved)),
    `the delete left the pinned checkout at ${pinnedIn(moved)}`,
  );
  await ctx.restartDesktop();
  await openHome(ctx);
  await ctx.page
    .locator("main.review-home .review-home-card")
    .filter({ hasText: TITLE })
    .click();

  const deleted = canvasUi(ctx);

  const deletedOutcome = await until(
    async () =>
      ((await deleted.unavailable.count()) > 0 && "unavailable") ||
      ((await deleted.heading.count()) > 0 && "rendered") ||
      ((await deleted.failure.count()) > 0 && "failed"),
    "the deleted worktree to report unavailable, render the stored document, or fail",
  );

  if (deletedOutcome === "failed") {
    await assertCanvasFailureSignature(
      ctx,
      review.reviewId,
      "deleted worktree",
    );
    ctx.check(
      "a deleted worktree leaves an opaque API error on the canvas (known bug)",
    );
  } else
    ctx.check(
      deletedOutcome === "unavailable"
        ? "a deleted worktree is surfaced as unavailable rather than a blank canvas"
        : "a deleted worktree still renders the stored document without its source",
    );
}
