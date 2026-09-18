/** Settings and migration guidance: the telemetry toggle and the theme choice
 *  keep their value across a restart, in the UI and in the stored preference;
 *  then a legacy review directory that cannot be read is followed to every
 *  place the product says anything about it. */
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

/** A stored record no schema accepts. `schemaVersion` 1 is not one of the
 *  legacy versions the importer migrates in place (2, 3 and 4 —
 *  `review-home.ts:731-738`), so it is the `MIGRATION_REQUIRED` shape from
 *  `review-home.ts:706-710` and not a record any code path can repair. */
const LEGACY_UUID = "11111111-1111-4111-8111-111111111111";

const LEGACY_RECORD = { schemaVersion: 1, uuid: LEGACY_UUID };

/** `applyReviewThemeChoice` writes a choice as workbench settings
 *  (`reviewThemeChoice.ts:41-56`); "system" is left out on purpose, because it
 *  stores an auto-detect flag instead of a theme name. */
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

/** The row label is a `<span>` and the checkbox's own `<label>` holds only its
 *  "On"/"Off" text (`settings-page.tsx:102-119`, `Row` at `:219-237`), so
 *  `getByLabel("Share anonymous usage data")` matches nothing; the row is the
 *  handle. The theme control is a real `<select aria-label="Theme">`
 *  (`settings-page.tsx:239-266`). */
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

/** Runs the Desktop's own server host against `home`, with no Electron and no
 *  window: `dist/server/desktop-host.js` starts itself unless
 *  `DEV_FAST_REVIEW_DESKTOP_HOST_AUTOSTART` is "0"
 *  (`server/desktop-host.ts:171-178`). Port 0 and a home of its own keep it
 *  clear of the journey's Desktop. */
async function runDesktopHost(ctx, home) {
  const env = {
    ...ctx.env,
    HOME: home,
    DEV_REVIEW_HOME: home,
    DEV_FAST_REVIEW_SERVER_PORT: "0",
    DEV_FAST_REVIEW_APP_PID: String(process.pid),
  };

  try {
    return {
      ...(await exec(
        process.execPath,
        [path.join(ctx.runtime, "dist/server/desktop-host.js")],
        { env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      )),
      code: 0,
    };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: error.code,
      // True when the host was still running at the timeout: it got past the
      // migration and started listening.
      killed: Boolean(error.killed),
    };
  }
}

export async function run(ctx) {
  const { until, userData } = ctx;

  let settings = await openSettings(ctx);

  const telemetry = telemetryToggle(settings);

  const before = await telemetry.isChecked();

  // The setting ships enabled (`reviewCanvasPart.ts:702-706`), so the flip
  // under test is an opt-out. The opposite direction is not safe to run: the
  // host drops DEV_FAST_REVIEW_TELEMETRY_DISABLED once it has bootstrapped
  // the stored value, precisely so a later in-app enable reaches the sender
  // (`server/desktop-host.ts:29-38`), and this journey does not redirect the
  // capture host the way `first-run` does.
  assert.ok(
    before,
    "the telemetry toggle started disabled, so flipping it would turn telemetry on",
  );
  await telemetry.click();
  await until(
    async () => (await telemetry.isChecked()) === !before,
    `the telemetry toggle to read ${!before}`,
  );
  // The preference is the whole effect under test: the harness runs with
  // DEV_FAST_REVIEW_TELEMETRY_DISABLED=1, so nothing may leave the machine
  // whichever way the toggle sits.
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

  // Home lists from the JSON store (`review-api/store.ts:485`), and the
  // one-time cutover that imports `<home>/reviews/<uuid>` into that store has
  // already run for this home, so it returns on its marker without reading the
  // directory again (`json-cutover.ts:238-270`). Nothing else reads a legacy
  // record in the Desktop: `listReviews`, where `MIGRATION_REQUIRED` comes from
  // (`review-home.ts:706-710`), has one non-test caller,
  // `publish-preparation.ts:24`, and `ReviewHomeError` appears nowhere in
  // `packages/review/app/src`. So the brief's Home text is asserted only if
  // this build grew it.
  const legacyDir = await seedLegacyReview(ctx.home);

  await ctx.restartDesktop();
  await openHome(ctx);

  const home = ctx.page.locator("main.review-home");

  // The onboarding rail is what an empty Home renders; waiting for it is what
  // makes the absences below mean "Home is finished", not "Home is slow".
  await home.getByText("Create your first review").waitFor({ timeout: 60000 });

  const summaries = await ctx.api("/reviews-api");

  assert.equal(summaries.status, 200, JSON.stringify(summaries.value));
  assert.deepEqual(
    summaries.value.filter((summary) => summary.reviewId === LEGACY_UUID),
    [],
    "the store listed a review it cannot read",
  );
  assert.deepEqual(
    await storedRecord(legacyDir),
    LEGACY_RECORD,
    "the Desktop rewrote the legacy record it cannot read",
  );

  // `innerText` is the rendered text, so a hidden node counts for neither
  // branch, and the uuid is the only identifier this record could be named by:
  // its title is empty (`review-home.ts:787`). Naming the review is what
  // makes the guidance this review's guidance rather than a mention of the
  // command somewhere else on the page.
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

  // The reader's real upgrade path is a home whose cutover has not run yet.
  // This one is past it, so the probe gets a home of its own under the
  // journey's temp root, holding the same record.
  const upgradeHome = path.join(ctx.root, "upgrade-home");

  await seedLegacyReview(upgradeHome);

  const host = await runDesktopHost(ctx, upgradeHome);

  // Only the logged bug may pass: the host refused to start, and said nothing
  // about the command its own MIGRATION_REQUIRED message names.
  assert.equal(
    host.code,
    1,
    `the host on an unmigrated home exited ${host.code}${host.killed ? " (killed at the timeout)" : ""}: ${host.stdout}`,
  );
  assert.match(
    host.stderr,
    /Review migration could not finish\./,
    `the host failed for another reason: ${host.stderr}`,
  );
  assert.doesNotMatch(
    host.stderr,
    /review migrate apply/,
    "the host named the command to run, which the logged bug says it does not",
  );
  await ctx.knownBug(
    "One unreadable legacy `review.json` stops Review Desktop from starting",
  );

  const migrate = await ctx.cliRaw(["migrate", "apply", "--force"], ctx.repo, {
    timeout: 120000,
  });

  const output = `${migrate.stdout}${migrate.stderr}`;

  // The blocker names the directory, so the uuid anchors it to this record
  // rather than to a blocker the machine's own state produced.
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
