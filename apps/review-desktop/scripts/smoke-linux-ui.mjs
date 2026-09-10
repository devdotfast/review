/** Exercise Linux titlebar behavior in an isolated packaged app under a window manager. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";

if (process.platform !== "linux") throw new Error("Run this check on Linux");
const packagedRoot = path.resolve(process.argv[2] ?? "apps/review-desktop/VSCode-linux-x64");
const output = path.resolve(process.argv[3] ?? "apps/review-desktop/dist/linux-ui");
await mkdir(output, { recursive: true });

for (const [controls, theme, scale] of [["native", "Review Dark", 1], ["custom", "Review Light", 1.25]]) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "review-linux-ui-"));
  await mkdir(path.join(profile, "User"));
  await writeFile(path.join(profile, "User/settings.json"), JSON.stringify({
    "window.controlsStyle": controls,
    "window.autoDetectColorScheme": false,
    "telemetry.telemetryLevel": "off",
    "workbench.colorTheme": theme,
    "window.confirmBeforeClose": "never",
    "update.mode": "none",
  }));
  const env = { ...process.env, DEV_REVIEW_HOME: path.join(profile, "review-home"), DEV_REVIEW_IMPORT_FROM: "none" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_DEV;
  delete env.VSCODE_CLI;
  let app;
  try {
    app = await electron.launch({
      executablePath: path.join(packagedRoot, "review"),
      args: ["--disable-dev-shm-usage", `--user-data-dir=${profile}`, `--extensions-dir=${path.join(profile, "extensions")}`, `--force-device-scale-factor=${scale}`],
      env,
      // Docker emulation cannot create Chromium namespaces. This opt-in is only
      // for local UI inspection; CI and the separate startup gate keep sandboxing.
      chromiumSandbox: process.env.REVIEW_TEST_DISABLE_SANDBOX !== "1",
      timeout: 90_000,
    });
    const page = await app.firstWindow({ timeout: 90_000 });
    page.setDefaultTimeout(30_000);
    const menu = page.getByRole("button", { name: "Review menu", exact: true });
    await menu.waitFor({ state: "visible" });
    await dismissStartupInvitations(page, menu);
    await page.locator(".review-onboarding-headline").waitFor({ state: "visible", timeout: 90_000 });
    if (controls === "native") {
      assert.equal(await page.evaluate(() => navigator.windowControlsOverlay?.visible), true, "Native Linux window controls overlay is inactive");
    }
    await page.keyboard.press("F10");
    await page.getByRole("menuitem", { name: /^Settings/ }).waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.closest(".monaco-menu"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".review-application-menu")?.getAttribute("aria-expanded") === "false");
    await menu.click();
    for (const name of [/^Manage Extensions/, /^Check for Updates/, /^About Review/, /^Quit Review/]) {
      await page.getByRole("menuitem", { name }).waitFor({ state: "visible" });
    }
    await page.screenshot({ path: path.join(output, `${controls}-menu.png`) });
    await page.waitForFunction(() => document.activeElement?.closest(".monaco-menu"));
    await page.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 600));
    // Electron's viewport resize can precede the workbench layout pass.
    await page.waitForFunction(() => {
      const titlebar = document.querySelector(".review-titlebar-container");
      const left = titlebar?.querySelector(".titlebar-left")?.getBoundingClientRect();
      const right = titlebar?.querySelector(".titlebar-right")?.getBoundingClientRect();
      return window.innerWidth <= 700 && left && right
        && left.right <= right.left && Math.abs(right.right - window.innerWidth) <= 1;
    }).catch(async (error) => {
      const bounds = await page.locator(".review-titlebar-container").evaluate(element => ({
        viewportWidth: window.innerWidth,
        left: element.querySelector(".titlebar-left").getBoundingClientRect().toJSON(),
        right: element.querySelector(".titlebar-right").getBoundingClientRect().toJSON(),
      }));
      throw new Error(`Linux titlebar did not finish resizing: ${JSON.stringify(bounds)}`, { cause: error });
    });
    if (controls === "custom") {
      await page.getByRole("button", { name: "Maximize", exact: true }).click();
      await page.getByRole("button", { name: "Restore", exact: true }).waitFor({ state: "visible" });
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true);
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByRole("button", { name: "Maximize", exact: true }).waitFor({ state: "visible" });
    }
    await page.screenshot({ path: path.join(output, `${controls}-narrow.png`) });
    if (controls === "custom") {
      await page.getByRole("button", { name: "Minimize", exact: true }).click();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())) break;
        await delay(50);
      }
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true);
      await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.focus(); });
      const closed = page.waitForEvent("close");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await closed;
    }
    console.log(`Linux ${controls} controls: keyboard menu, actions, narrow layout, scale ${scale} passed`);
  } catch (error) {
    const page = app?.windows()[0];
    if (page) {
      console.error(await page.locator(".monaco-dialog-modal-block").allTextContents().catch(() => []));
      await page.screenshot({ path: path.join(output, `${controls}-failure.png`) }).catch(() => {});
    }
    throw error;
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close();
    }
    await rm(profile, { recursive: true, force: true });
  }
}

async function dismissStartupInvitations(page, menu) {
  // Invitations are optional startup UI, not a prerequisite for titlebar checks.
  await page.getByRole("button", { name: "Not now", exact: true })
    .or(page.locator(".review-onboarding-headline")).first()
    .waitFor({ state: "visible", timeout: 90_000 });
  for (let prompt = 0; prompt < 5; prompt++) {
    const notNow = page.getByRole("button", { name: "Not now", exact: true });
    try {
      await notNow.waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      return;
    }
    await page.keyboard.press("F10");
    assert.equal(await menu.getAttribute("aria-expanded"), "false", "Menu opened over a modal dialog");
    await page.getByRole("checkbox", { name: "Don't show again", exact: true }).check();
    await notNow.click();
    await page.locator(".monaco-dialog-modal-block").waitFor({ state: "hidden" });
  }
}
