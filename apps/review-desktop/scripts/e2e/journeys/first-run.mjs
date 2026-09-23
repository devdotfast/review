/** A fresh profile meets the community invitation, the telemetry notice and the onboarding rail, and keeps those choices. */
import assert from "node:assert/strict";

import { assertNoBlockedReviewRequests } from "../../review-network-policy.mjs";
import { readApplicationStorage } from "../storage.mjs";

export const name = "first-run";

export const phase = 1;

export const options = {
  seedRepo: false,
  // Restore the real first-run telemetry notice, but point capture at a closed local port.
  env: {
    DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED: "",
    PROGRESSIVE_WHITEBOARD_POSTHOG_HOST: "http://127.0.0.1:9",
  },
  disableCommunityHandler: true,
};

const COMMUNITY_DISMISSED_KEY = "review.community.dontShowAgain";

const TELEMETRY_NOTICE_KEY = "review.telemetry.noticeShown.v1";

/** Storage booleans arrive as `true`; a JSON-encoded `"true"` counts as well. */
const isStoredTrue = (value) => value === "true" || value === '"true"';

/** True when the locator turns up within `timeout`, false when it does not. */
const appears = (locator, timeout) =>
  locator.waitFor({ timeout }).then(
    () => true,
    () => false,
  );

/** The stored value for `key`, or undefined when the workbench flushed none within `timeout`. */
const storedValue = (ctx, key, timeout = 10000) =>
  ctx
    .until(
      () => readApplicationStorage(ctx.userData, key),
      `${key} in application storage`,
      timeout,
    )
    .catch((error) => {
      // Only a timeout means "nothing was stored"; the Desktop's exit diagnostic must stay fatal.
      if (!error.message.startsWith("Timed out waiting for")) throw error;

      return undefined;
    });

export async function run(ctx) {
  const { page, until, userData } = ctx;

  const dialog = page.getByText("Join the Whiteboard community", {
    exact: true,
  });

  const dismissDialog = async () => {
    await page.getByRole("checkbox", { name: "Don't show again" }).check();
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };

  await dialog.waitFor({ timeout: 30000 });
  await dismissDialog();

  // A fresh profile reloads the workbench about two seconds in; the invitation waits for it, so one dismissal is final.
  assert.ok(
    !(await appears(dialog, 20000)),
    "the community invitation returned after the first-run reload",
  );

  const dismissed = await storedValue(ctx, COMMUNITY_DISMISSED_KEY);

  assert.ok(
    isStoredTrue(dismissed),
    `${COMMUNITY_DISMISSED_KEY} was not stored (${dismissed})`,
  );
  ctx.check(
    "community invitation shows once on a fresh profile and stays dismissed",
  );

  // Exact, because the screen-reader alert repeats the text with an "Info: " prefix.
  const notice = page.getByText(
    "Whiteboard sends anonymous usage data. You can change this in Settings.",
    { exact: true },
  );

  // Sticky, so it outlives both the seeding reload and the 10 s a plain Info toast gets.
  assert.ok(
    await appears(notice, 30000),
    "the telemetry notice never appeared",
  );
  await page.getByRole("button", { name: "Open Settings" }).click();
  await page
    .locator(".review-settings-page")
    .getByText("Share anonymous usage data")
    .waitFor();
  ctx.check("telemetry notice opens Settings at the Privacy row");

  const tab = page
    .locator(".tabs-container .tab")
    .filter({ hasText: /^Home$/ })
    .first();

  await tab.click();

  const welcome = page.locator("main.review-home");

  await welcome.getByText("Connect your agents").waitFor();
  await welcome.getByText("Take the tour").waitFor();
  await welcome.getByText("Create your first review").waitFor();
  // The rail renders only the open step's body, so the tutorial entry point is behind the second step's disclosure.
  await welcome.getByRole("button", { name: "Expand Take the tour" }).click();
  await welcome.getByRole("button", { name: "Open the tutorial" }).waitFor();
  ctx.check("empty Home renders the three-step onboarding rail");

  await until(
    () =>
      isStoredTrue(readApplicationStorage(userData, COMMUNITY_DISMISSED_KEY)),
    "community dismissal persisted",
  );
  await until(
    () => readApplicationStorage(userData, TELEMETRY_NOTICE_KEY) !== undefined,
    "telemetry notice marked shown",
  );

  await ctx.restartDesktop();
  await ctx.page.locator("main.review-home").waitFor({ timeout: 60000 });
  await ctx.page.waitForTimeout(3000);
  assert.equal(
    await ctx.page
      .getByText("Join the Whiteboard community", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await ctx.page.getByText("Whiteboard sends anonymous usage data").count(),
    0,
  );
  ctx.check("dismissed dialog and notice stay hidden after a restart");

  assertNoBlockedReviewRequests(ctx.requestUrls);
  ctx.check("no request left for a blocked host while telemetry was live");
}
