/** The built-in tutorial renders as a native JSON review and a reader drives every step; completion is read from storage. */
import assert from "node:assert/strict";
import path from "node:path";

import { dismissModalEditor, openHome } from "../harness.mjs";
import { readApplicationStorage } from "../storage.mjs";

export const name = "tutorial";

export const phase = 1;

export const options = { seedRepo: false };

const TITLE = "Review Desktop: three-minute tour";

const PROGRESS_KEY = "review.tutorial.progress.v1";

/** Every step of the tour with the software map enabled, in plan order. */
const STEPS = [
  "chooseKeymap",
  "showHover",
  "gotoDefinition",
  "openPeek",
  "openCommits",
  "openDiff",
  "openSequence",
  "openMap",
  "openDatabase",
  "openTraceQuote",
  "getHelp",
];

const progress = (ctx) => {
  const raw = readApplicationStorage(ctx.userData, PROGRESS_KEY);

  return raw ? JSON.parse(raw) : { checked: [], dismissed: false };
};

async function waitChecked(ctx, id) {
  await ctx.until(
    () => progress(ctx).checked.includes(id),
    `tutorial step ${id} checked`,
    30000,
  );
  ctx.check(`tutorial: ${id}`);
}

export async function run(ctx) {
  const { apiCanvasFor, until, root } = ctx;

  await ctx.page.keyboard.press("F1");
  await ctx.page
    .locator(".quick-input-widget input")
    .fill(">Review: Open Tutorial");
  await ctx.page
    .getByRole("option", { name: /Review: Open Tutorial/ })
    .click();

  const page = await apiCanvasFor(TITLE);

  await ctx.watchPage(page);
  await page.getByRole("complementary", { name: "Tutorial guide" }).waitFor();

  const keybindings = page.getByRole("group", { name: "Keybindings" });

  await keybindings.getByRole("button", { name: "VS Code default" }).click();
  await until(
    async () =>
      (await keybindings
        .getByRole("button", { name: "VS Code default" })
        .getAttribute("aria-pressed")) === "true",
    "tutorial keybinding selection",
  );
  await page.screenshot({ path: path.join(root, "tutorial.png") });
  ctx.check(
    "native JSON tutorial renders with its guide and working keybinding picker",
  );

  const canvas = page.locator(".review-canvas-root [data-review-api]");

  const guide = page.locator(
    'aside.tutorial-guide[aria-label="Tutorial guide"]',
  );

  const viewTab = (label) =>
    page.locator(`[aria-label="Review views"] button[aria-label="${label}"]`);

  await guide.waitFor();

  // The picker's bridge checks the step before it runs the keymap command, so the render check above completed it.
  await waitChecked(ctx, "chooseKeymap");

  const editor = canvas
    .locator('[data-review-section="Welcome"] .review-inline-editor')
    .first();

  await editor.locator(".view-line").first().waitFor();

  // `inline-hover` completes on non-empty hover contents, so this is a real tsserver test.
  const tokens = editor
    .locator(".view-line span")
    .filter({ hasText: /^[A-Za-z_]\w{2,}$/ });

  // A hover widget outlives the hover it showed, so the step's own record is the only reliable signal.
  await until(
    async () => {
      const count = await tokens.count();

      for (let index = 0; index < Math.min(count, 12); index++) {
        await tokens.nth(index).hover();
        await page.waitForTimeout(600);

        if (progress(ctx).checked.includes("showHover")) return true;
      }

      return false;
    },
    "tsserver hover in the Welcome editor",
    90000,
  );
  await waitChecked(ctx, "showHover");

  await page.keyboard.press("Escape");

  // `totalCents` is declared and used inside the authored window, so tsserver can always resolve it.
  await editor
    .locator(".view-line span")
    .filter({ hasText: /^totalCents$/ })
    .first()
    .click();
  await page.keyboard.press("F12");
  // `inline-navigation` completes on an actual navigation.
  await waitChecked(ctx, "gotoDefinition");

  // `didNavigate` records the step before the modal editor opens, so wait for the modal rather than assume it is up.
  await dismissModalEditor(ctx, page);
  await guide.waitFor();

  await canvas
    .locator('[data-review-section="Welcome"] a[data-review-anchor-id]')
    .first()
    .click();
  await waitChecked(ctx, "openPeek");

  await viewTab("Commits").click();
  await waitChecked(ctx, "openCommits");
  await page.locator(".review-commit-open").first().click();
  await waitChecked(ctx, "openDiff");
  await viewTab("Review").click();

  // The two `external` steps complete when the tour overlay mounts, not when the reader steps through it.
  await canvas
    .locator(
      '[data-review-section="Interactive Diagrams"] .sequence-diagram .diagram-tour-button',
    )
    .first()
    .click();
  await page.locator('[role="dialog"][aria-label$=" tour"]').waitFor();
  await waitChecked(ctx, "openSequence");
  await page.keyboard.press("Escape");

  await viewTab("Map (Experimental)").click();
  await waitChecked(ctx, "openMap");
  await viewTab("Review").click();

  await canvas
    .locator(
      '[data-review-section="Interactive Diagrams"] .database-lens .diagram-tour-button',
    )
    .first()
    .click();
  await page.locator('[role="dialog"][aria-label$=" tour"]').waitFor();
  await waitChecked(ctx, "openDatabase");
  await page.keyboard.press("Escape");

  await canvas
    .locator('[data-review-section="Agent traces"] .review-trace-quote')
    .first()
    .click();
  await waitChecked(ctx, "openTraceQuote");

  await guide.getByRole("button", { name: "Finish tour" }).click();
  await waitChecked(ctx, "getHelp");

  const final = progress(ctx);

  assert.deepEqual([...final.checked].sort(), [...STEPS].sort());
  ctx.check("all eleven tutorial steps are checked in application storage");

  await openHome(ctx);

  const home = ctx.page.locator("main.review-home");

  await home.getByText(`${STEPS.length} of ${STEPS.length} checks`).waitFor();

  // The rail opens the first unfinished step, and only an open step renders its body.
  const expand = home.getByRole("button", { name: "Expand Take the tour" });

  if (await expand.count()) await expand.click();
  await home.getByRole("button", { name: "Reopen the tutorial" }).waitFor();
  ctx.check("Welcome shows 11 of 11 and Reopen the tutorial");

  const status = async () => (await ctx.api("/tutorial/status")).value;

  await ctx.api("/tutorial", "DELETE");

  assert.equal((await status()).reviewUuid, null);
  await ctx.api("/tutorial/prepare", "POST", {});
  await until(async () => (await status()).reviewUuid, "tutorial re-prepared");
  ctx.check("DELETE /tutorial then prepare restores the hidden review");
}
