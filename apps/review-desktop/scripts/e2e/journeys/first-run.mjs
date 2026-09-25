/** A fresh profile meets the telemetry notice and the onboarding rail; two sessions later, the community invitation, once. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { assertNoBlockedReviewRequests } from "../../review-network-policy.mjs";
import {
  COMMUNITY_INVITATION,
  createReview,
  orderReviewBlocks,
} from "../harness.mjs";
import { readApplicationStorage } from "../storage.mjs";

export const name = "first-run";

export const phase = 1;

export const options = {
  seedRepo: false,
  // Restore the real first-run telemetry notice, but point capture at a closed local port.
  env: {
    DEV_FAST_REVIEW_TELEMETRY_DISABLED: "",
    PROGRESSIVE_REVIEW_POSTHOG_HOST: "http://127.0.0.1:9",
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
  const { until, userData } = ctx;

  let { page } = ctx;

  const invitation = () =>
    ctx.page.getByText(COMMUNITY_INVITATION, { exact: true });

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

  await welcome.getByText("Install the whiteboard command").waitFor();
  await welcome.getByText("Connect your agents").waitFor();
  await welcome.getByText("Take the tour").waitFor();
  await welcome.getByText("Create your first session").waitFor();
  // A fresh home has no `whiteboard` command, so the rail opens on installing it and holds the later steps shut.
  await welcome
    .getByRole("button", { name: "Install whiteboard in PATH" })
    .waitFor();
  assert.equal(
    await welcome
      .getByRole("button", { name: "Expand Take the tour" })
      .isEnabled(),
    false,
    "the tour step opened before the whiteboard command was installed",
  );
  ctx.check(
    "empty Home renders the onboarding rail, opened on installing the command",
  );

  await until(
    () => readApplicationStorage(userData, TELEMETRY_NOTICE_KEY) !== undefined,
    "telemetry notice marked shown",
  );

  // The invitation waits for a profile with two sessions, so a fresh one never sees it.
  assert.equal(
    await invitation().count(),
    0,
    "the community invitation showed on an empty profile",
  );
  assert.equal(
    await storedValue(ctx, COMMUNITY_DISMISSED_KEY, 2000),
    undefined,
    `${COMMUNITY_DISMISSED_KEY} was stored before the invitation was shown`,
  );
  ctx.check("an empty profile is not shown the community invitation");

  await seedRepository(ctx);

  for (const title of ["First session", "Second session"])
    await createReview(ctx, { title, blocks: orderReviewBlocks });

  await ctx.restartDesktop();
  page = ctx.page;
  await invitation().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await invitation().waitFor({ state: "hidden" });

  const dismissed = await storedValue(ctx, COMMUNITY_DISMISSED_KEY);

  assert.ok(
    isStoredTrue(dismissed),
    `${COMMUNITY_DISMISSED_KEY} was not stored (${dismissed})`,
  );
  ctx.check(
    "the community invitation shows once the profile holds two sessions, and Not now stores the answer",
  );

  await ctx.restartDesktop();
  await ctx.page.locator(".monaco-workbench").waitFor({ timeout: 60000 });
  assert.ok(
    !(await appears(invitation(), 15000)),
    "the community invitation returned after it was answered",
  );
  assert.equal(
    await ctx.page.getByText("Whiteboard sends anonymous usage data").count(),
    0,
  );
  ctx.check(
    "the answered invitation and the notice stay hidden after a restart",
  );

  assertNoBlockedReviewRequests(ctx.requestUrls);
  ctx.check("no request left for a blocked host while telemetry was live");
}

/** Commits a draft and a queued `order.ts` into the journey's empty repository, after launch, so the profile starts with no sessions. */
async function seedRepository(ctx) {
  const { git, repo } = ctx;

  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Review E2E");
  await git("config", "user.email", "review-e2e@example.invalid");
  await writeFile(
    path.join(repo, "order.ts"),
    'export const status = "draft";\n',
  );
  await git("add", ".");
  await git("commit", "-qm", "Draft");
  ctx.base = await git("rev-parse", "HEAD");
  await writeFile(
    path.join(repo, "order.ts"),
    'export const status = "queued";\n',
  );
  await git("commit", "-qam", "Queue");
  ctx.head = await git("rev-parse", "HEAD");
}
