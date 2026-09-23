/** The telemetry toggle and the theme choice survive a restart; then an unreadable legacy record is followed everywhere. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { openHome, openSettings } from "../harness.mjs";
import { readUserSettings } from "../storage.mjs";

export const name = "settings-and-migration";

export const phase = 1;

export const options = {};

const exec = promisify(execFile);

/** A stored record no schema accepts: `schemaVersion` 1 is not one the importer migrates in place, so nothing can repair it. */
const LEGACY_UUID = "11111111-1111-4111-8111-111111111111";

const LEGACY_RECORD = { schemaVersion: 1, uuid: LEGACY_UUID };

/** How a theme choice lands in workbench settings; "system" is left out because it stores an auto-detect flag instead. */
const THEME_SETTINGS = {
  dark: {
    "window.autoDetectColorScheme": false,
    "workbench.colorTheme": "Review Dark",
  },
  light: {
    "window.autoDetectColorScheme": false,
    "workbench.colorTheme": "Review Light",
  },
};

/** The telemetry checkbox, reached through its row: the row label is a `<span>`, so `getByLabel` matches nothing. */
const telemetryToggle = (settings) =>
  settings
    .locator(".review-settings-row")
    .filter({ hasText: "Share anonymous usage data" })
    .locator('input[type="checkbox"]');

const themeSelect = (settings) => settings.getByLabel("Theme");

/** Writes the unreadable record into `<home>/reviews/<uuid>/review.json`. */
async function seedLegacyReview(home) {
  const dir = path.join(home, "reviews", LEGACY_UUID);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.json"), JSON.stringify(LEGACY_RECORD));

  return dir;
}

const storedRecord = async (dir) =>
  JSON.parse(await readFile(path.join(dir, "review.json"), "utf8"));

/** A host that listens never exits on its own, so the timeout is what ends the run. */
const HOST_LIFETIME = 20000;

/** Runs the Desktop's own server host against `home`, with no Electron and no window, on a port of its own. */
async function runDesktopHost(ctx, home) {
  const env = {
    ...ctx.env,
    HOME: home,
    DEV_WHITEBOARD_HOME: home,
    DEV_FAST_WHITEBOARD_SERVER_PORT: "0",
    DEV_FAST_WHITEBOARD_APP_PID: String(process.pid),
  };

  try {
    return {
      ...(await exec(
        process.execPath,
        [path.join(ctx.runtime, "dist/server/desktop-host.js")],
        { env, timeout: HOST_LIFETIME, maxBuffer: 8 * 1024 * 1024 },
      )),
      code: 0,
    };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: error.code,
    };
  }
}

export async function run(ctx) {
  const { until, userData } = ctx;

  let settings = await openSettings(ctx);

  const telemetry = telemetryToggle(settings);

  const before = await telemetry.isChecked();

  // The setting ships enabled, so the flip under test is an opt-out; this journey does not redirect the capture host.
  assert.ok(
    before,
    "the telemetry toggle started disabled, so flipping it would turn telemetry on",
  );
  await telemetry.click();
  await until(
    async () => (await telemetry.isChecked()) === !before,
    `the telemetry toggle to read ${!before}`,
  );
  // The preference is the whole effect under test; the harness runs with telemetry disabled whichever way it sits.
  await until(
    () => readUserSettings(userData)["review.telemetry.enabled"] === !before,
    `review.telemetry.enabled to be ${!before} in the workbench settings`,
  );

  const theme =
    (await themeSelect(settings).inputValue()) === "light" ? "dark" : "light";

  await themeSelect(settings).selectOption(theme);
  await until(
    async () => (await themeSelect(settings).inputValue()) === theme,
    `the theme control to read ${theme}`,
  );
  await until(() => {
    const stored = readUserSettings(userData);

    return Object.entries(THEME_SETTINGS[theme]).every(
      ([key, value]) => stored[key] === value,
    );
  }, `the ${theme} theme in the workbench settings`);

  await ctx.restartDesktop();

  settings = await openSettings(ctx);
  assert.equal(
    await telemetryToggle(settings).isChecked(),
    !before,
    "the telemetry toggle did not keep its value across the restart",
  );
  assert.equal(
    await themeSelect(settings).inputValue(),
    theme,
    "the theme control did not keep its value across the restart",
  );

  const restored = await until(
    () => readUserSettings(userData),
    "the workbench settings to be readable after the restart",
  );

  assert.equal(
    restored["review.telemetry.enabled"],
    !before,
    "review.telemetry.enabled did not survive the restart",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(THEME_SETTINGS[theme]).map((key) => [key, restored[key]]),
    ),
    THEME_SETTINGS[theme],
    `the ${theme} theme settings did not survive the restart`,
  );
  ctx.check(
    "the telemetry toggle and the theme choice persist across a restart",
  );

  // Nothing in the Desktop reads a legacy record once the cutover marker is set, so Home's text is asserted only if it does.
  const legacyDir = await seedLegacyReview(ctx.home);

  await ctx.restartDesktop();
  await openHome(ctx);

  const home = ctx.page.locator("main.review-home");

  // The onboarding rail is what an empty Home renders, so waiting for it makes the absences below mean "finished", not "slow".
  await home.getByText("Create your first review").waitFor({ timeout: 60000 });

  const summaries = await ctx.api("/sessions-api");

  assert.equal(summaries.status, 200, JSON.stringify(summaries.value));
  assert.deepEqual(
    summaries.value.filter((summary) => summary.sessionId === LEGACY_UUID),
    [],
    "the store listed a review it cannot read",
  );
  assert.deepEqual(
    await storedRecord(legacyDir),
    LEGACY_RECORD,
    "the Desktop rewrote the legacy record it cannot read",
  );

  // `innerText` is the rendered text, and the uuid is the only identifier this record could be named by: its title is empty.
  const homeText = await home.innerText();

  if (homeText.includes(LEGACY_UUID)) {
    assert.match(
      homeText,
      /review migrate apply/,
      "Home named the unreadable review but not the command to run",
    );
    ctx.check(
      "Home surfaces a legacy review that needs migration with the command to run",
    );
  } else {
    assert.doesNotMatch(
      homeText,
      /review migrate apply/,
      "Home offered migration guidance without naming the review it is about",
    );
    ctx.check(
      "a legacy review directory the cutover never saw stays out of Home and is left untouched",
    );
  }

  // The reader's real upgrade path is a home whose cutover has not run, so the probe gets one of its own.
  const upgradeHome = path.join(ctx.root, "upgrade-home");

  await seedLegacyReview(upgradeHome);

  const host = await runDesktopHost(ctx, upgradeHome);

  // The host writes its discovery the moment it listens, so the ready line is what "it got past the cutover" means.
  assert.match(
    host.stdout,
    /"event":"ready"/,
    `the host on an unmigrated home never listened (exit ${host.code}): ${host.stdout}\n${host.stderr}`,
  );
  assert.match(
    host.stdout,
    new RegExp(
      `${LEGACY_UUID}: unreadable review\\.json, left untouched and skipped`,
    ),
    `the host did not name the skipped record: ${host.stdout}`,
  );
  ctx.check("an unreadable legacy review.json is skipped and named at startup");

  const migrate = await ctx.cliRaw(["migrate", "apply", "--force"], ctx.repo, {
    timeout: 120000,
  });

  const output = `${migrate.stdout}${migrate.stderr}`;

  // The blocker names the directory, so the uuid anchors it to this record rather than to the machine's own state.
  assert.match(
    output,
    new RegExp(
      `${LEGACY_UUID}: current artifact migration failed: Unsupported Review schema; the record was preserved\\.`,
    ),
    `review migrate apply did not report the record: ${output}`,
  );
  assert.equal(
    migrate.code,
    1,
    `review migrate apply reported a blocker but exited ${migrate.code}: ${output}`,
  );
  assert.deepEqual(
    await storedRecord(legacyDir),
    LEGACY_RECORD,
    "review migrate apply changed the record it reported as preserved",
  );
  ctx.check(
    "`review migrate apply` is the one place the unreadable record is reported, and it preserves it",
  );
}
