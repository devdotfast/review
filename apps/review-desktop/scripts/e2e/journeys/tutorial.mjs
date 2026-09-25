/** The built-in tutorial renders as a native JSON review and a reader drives every step; completion is read from storage. */
import assert from "node:assert/strict";
import path from "node:path";

import { closeSourceWindow, openHome, sourceWindowFor } from "../harness.mjs";
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
    .fill(">Whiteboard: Open Tutorial");
  await ctx.page
    .getByRole("option", { name: /Whiteboard: Open Tutorial/ })
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
    page.locator(`[aria-label="Session views"] button[aria-label="${label}"]`);

  await guide.waitFor();

  // The picker's bridge checks the step before it runs the keymap command, so the render check above completed it.
  await waitChecked(ctx, "chooseKeymap");

  const editor = canvas
    .locator('[data-review-section="Welcome"] .review-inline-editor')
    .first();

  await editor.locator(".view-line").first().waitFor();

  // Monaco's inner spans are its tokens; a whole identifier of three or more characters is something tsserver can describe.
  const tokens = editor
    .locator(".view-line span span")
    .filter({ hasText: /^[A-Za-z_]\w{2,}$/ });

  const hover = page.locator(".monaco-hover-content:visible").first();

  await editor.scrollIntoViewIfNeeded();

  // A real tsserver hover, not the step's record: the record is what the known bug below never writes.
  await until(
    async () => {
      const count = await tokens.count();

      for (let index = 0; index < Math.min(count, 24); index++) {
        const box = await tokens.nth(index).boundingBox();

        if (!box) continue;

        // Monaco shows a hover once the pointer rests, so each attempt comes in from off the line.
        await page.mouse.move(box.x, box.y - 40);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1500);

        if ((await hover.innerText({ timeout: 500 }).catch(() => "")).trim())
          return true;
      }

      return false;
    },
    "tsserver hover in the Welcome editor",
    90000,
  );
  ctx.check("tutorial: the Welcome editor shows tsserver hovers");

  await page.keyboard.press("Escape");

  // `totalCents` is declared and used inside the authored window, so tsserver can always resolve the use to the declaration.
  const use = editor
    .locator(".view-line")
    .filter({ hasText: /paymentToken,\s*totalCents\);\s*$/ })
    .first();

  await use.scrollIntoViewIfNeeded();

  const { x, y, height } = await use.boundingBox();

  // The pointer only picks the line (a mouse click: Monaco's overflow guard fails a locator's hit test); the keyboard
  // then puts the caret inside the name, so a drift between pointer and column cannot move it.
  await page.mouse.click(x + 40, y + height / 2);
  await page.keyboard.press("End");

  for (let step = 0; step < "ts);".length + 1; step++)
    await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("F12");

  // Go to Definition opens the file in the native Source window.
  const source = await sourceWindowFor(
    ctx,
    "order-service.ts",
    "order-service.ts after Go to Definition",
  );

  ctx.check("tutorial: Go to Definition opens the Source window");
  await closeSourceWindow(source);
  await guide.waitFor();

  // The code views stopped reporting hovers and navigations, so neither step completes on its own; see KNOWN_BUGS.md.
  await page.waitForTimeout(3000);
  assert.deepEqual(
    progress(ctx).checked.filter((id) =>
      ["showHover", "gotoDefinition"].includes(id),
    ),
    [],
    "a hover or Go to Definition completed its tutorial step",
  );
  await ctx.knownBug(
    "The tutorial's hover and Go to Definition steps never complete on their own",
  );

  for (const id of ["showHover", "gotoDefinition"]) {
    await guide.getByRole("button", { name: "Next", exact: true }).click();
    await waitChecked(ctx, id);
  }

  await canvas
    .locator('[data-review-section="Welcome"] a[data-review-anchor-id]')
    .first()
    .click();
  await waitChecked(ctx, "openPeek");

  await viewTab("Commits").click();
  await waitChecked(ctx, "openCommits");
  await page.locator(".review-commit-open").first().click();
  await waitChecked(ctx, "openDiff");
  await viewTab("Whiteboard").click();

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
  await viewTab("Whiteboard").click();

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

  // The later steps stay shut until the `whiteboard` command is installed, which this isolated home has not done.
  if ((await expand.count()) && !(await expand.isEnabled())) {
    await home
      .getByRole("button", { name: "Install whiteboard in PATH" })
      .waitFor();
    ctx.check(
      "Welcome shows 11 of 11 while the rail waits for the whiteboard command",
    );
  } else {
    if (await expand.count()) await expand.click();
    await home.getByRole("button", { name: "Reopen the tutorial" }).waitFor();
    ctx.check("Welcome shows 11 of 11 and Reopen the tutorial");
  }

  const status = async () => (await ctx.api("/tutorial/status")).value;

  await ctx.api("/tutorial", "DELETE");

  assert.equal((await status()).reviewUuid, null);
  await ctx.api("/tutorial/prepare", "POST", {});
  await until(async () => (await status()).reviewUuid, "tutorial re-prepared");
  ctx.check("DELETE /tutorial then prepare restores the hidden review");
}
