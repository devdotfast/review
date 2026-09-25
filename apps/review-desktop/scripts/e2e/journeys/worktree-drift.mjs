/** One review outliving its worktree: dirtied, renamed, deleted, re-read each time; the working copy's bytes must never show. */
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

/** The banner a snapshot marked `sourceUnavailable` renders instead of the source (see api-document.tsx). */
const RETAINED_SOURCE = "Local checkout unavailable. Showing retained source.";

/** Every locator this journey uses, rebuilt from the current `ctx.page` because each restart replaces it. */
function canvasUi(ctx) {
  const canvas = ctx.page.locator(".review-canvas-root [data-review-api]");

  return {
    heading: canvas.getByRole("heading", { name: TITLE, exact: true }),
    // The state a missing checkout is meant to reach (see desktop-entry.tsx).
    unavailable: ctx.page.getByText("Worktree unavailable"),
    retained: canvas.getByText(RETAINED_SOURCE),
    // What the canvas renders instead of the review when a source-backed read fails (see KNOWN_BUGS.md).
    failed: canvas.getByText(/^ReviewApiError: Review operation failed/),
    peek: canvas
      .locator('.review-inline-editor[data-review-inline-editor="order.ts"]')
      .first(),
  };
}

const LOST_REPOSITORY_BUG =
  "A review whose repository directory moved fails with `ReviewApiError` again: `/commits` has no degradation";

/** Corroborates that a failed render is the lost-repository bug: `/commits` cannot find the registered directory. */
async function lostRepositoryBug(ctx, reviewId, registered) {
  assert.ok(
    ctx
      .appLog()
      .includes(
        `GET /reviews-api/${reviewId}/commits failed: Error: No Git or jj repository found for ${registered}.`,
      ),
    `the canvas failed, but not because /commits lost ${registered}`,
  );
  await ctx.knownBug(LOST_REPOSITORY_BUG);
}

/** Runs `change`, then restarts; Windows will not move or delete a directory the running Desktop holds open, so there `change` runs while it is stopped. */
async function changeThenRestart(ctx, change) {
  if (process.platform === "win32") {
    await ctx.restartDesktop({ beforeRelaunch: change });

    return;
  }

  await change();
  await ctx.restartDesktop();
}

export async function run(ctx) {
  const { repo, until } = ctx;

  // Dirtied before the review exists, so the peek resolves once, against a tree that already differs from the pinned head.
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

  // The pinned checkout sits inside the repository directory, so it travels with the rename and dies with the delete.
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

  // The control for everything below: the same restart and open, with the repository still where it was registered.
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

  await changeThenRestart(ctx, async () => {
    await rename(repo, moved);
    assert.ok(
      existsSync(pinnedIn(moved)),
      `the rename did not carry the pinned checkout to ${pinnedIn(moved)}`,
    );
  });
  await pickReview(ctx, review.reviewId, moved);

  const { heading, unavailable, failed } = canvasUi(ctx);

  // The rename leaves the pinned checkout intact, so a full render is as legitimate as the degraded state.
  const outcome = await until(
    async () =>
      ((await unavailable.count()) > 0 && "unavailable") ||
      ((await heading.count()) > 0 && "rendered") ||
      ((await failed.count()) > 0 && "failed"),
    "the moved worktree to report unavailable, render the pinned review or fail",
  );

  if (outcome === "failed") await lostRepositoryBug(ctx, review.reviewId, repo);
  else
    ctx.check(
      outcome === "unavailable"
        ? "a moved worktree is reported as unavailable"
        : "a moved worktree still renders from the pinned checkout",
    );

  const info = await ctx.cliRaw(
    ["info", "--session", review.reviewId, "--json"],
    moved,
  );

  assert.equal(info.code, 0, `review info: ${info.stdout}\n${info.stderr}`);
  assert.match(
    info.stdout,
    new RegExp(review.reviewId),
    `review info named no review: ${info.stdout}`,
  );
  ctx.check("info resolves a review whose worktree moved");

  await changeThenRestart(ctx, async () => {
    await rm(moved, { recursive: true, force: true, maxRetries: 10 });
    assert.ok(
      !existsSync(pinnedIn(moved)),
      `the delete left the pinned checkout at ${pinnedIn(moved)}`,
    );
  });
  await openHome(ctx);
  await ctx.page
    .locator("main.review-home .review-home-table-open")
    .filter({ hasText: TITLE })
    .click();

  const deleted = canvasUi(ctx);

  // `Worktree unavailable` belongs to the source-file view this path never opens, so the document is the only outcome.
  const rendered = await until(
    async () =>
      ((await deleted.heading.count()) > 0 && "rendered") ||
      ((await deleted.failed.count()) > 0 && "failed"),
    "the deleted worktree to render the stored document",
  );

  if (rendered === "failed") {
    await lostRepositoryBug(ctx, review.reviewId, repo);

    return;
  }

  // Nothing is left to read from, so the retained document has to say so rather than pass for a current one.
  await deleted.retained.waitFor();

  const views = ctx.page.locator('[aria-label="Session views"]');

  await views.locator('button[aria-label="Commits"]').click();

  const commits = ctx.page.locator(".review-view-region--commits");

  await commits
    .getByRole("heading", { name: "Commits unavailable", exact: true })
    .waitFor();
  assert.equal(
    await commits.getByText(/\d+ commits/).count(),
    0,
    "the Commits tab counted commits although the checkout is gone",
  );
  ctx.check(
    "a deleted worktree renders the retained document with its banner, and Commits says it is unavailable",
  );
}
