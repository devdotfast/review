import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createReview, openSettings } from "../harness.mjs";

export const name = "diffr-settings";

export const phase = 1;

export const options = {
  settings: { "whiteboard.experimental.structuralDiff.enabled": true },
  env: { REVIEW_DIFFR_BINARY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" },
  async beforeLaunch(ctx) {
    ctx.env.XDG_CONFIG_HOME = path.join(ctx.root, "config");
    await mkdir(path.join(ctx.repo, "tests"), { recursive: true });
    const file = path.join(ctx.repo, "tests/check.rs");

    const source = (number) =>
      `#[test]\nfn calculates() {\n    let a = 1;\n    let b = 2;\n    let c = a + b;\n    let d = c * 2;\n    assert_eq!(d, ${number});\n}\n`;

    await writeFile(file, source(6));
    await ctx.git("add", ".");
    await ctx.git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "before settings",
    );
    ctx.base = await ctx.git("rev-parse", "HEAD");
    await writeFile(file, source(7));
    await ctx.git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qam",
      "after settings",
    );
    ctx.head = await ctx.git("rev-parse", "HEAD");
  },
};

function testFolds(events) {
  function walk(regions = []) {
    return regions.flatMap((region) => [region, ...walk(region.children)]);
  }

  return events
    .filter((event) => event.type === "file")
    .flatMap((event) => walk(event.diff?.rhs?.regions))
    .filter(
      (region) =>
        region.tags?.includes("test-bodies:test") &&
        region.visibility?.collapsed,
    );
}

export async function run(ctx) {
  const review = await createReview(ctx, {
    title: "diffr settings validation",
    blocks: [
      {
        type: "code_peek",
        source: {
          file: "tests/check.rs",
          start: { side: "head", line: 1 },
          end: { side: "head", line: 8 },
        },
      },
    ],
  });

  async function comparison() {
    const response = await fetch(
      new URL(
        `/sessions-api/${review.sessionId}/structural-diff`,
        ctx.discovery.url,
      ),
      {
        headers: { "x-whiteboard-token": ctx.discovery.token },
      },
    );

    assert.equal(response.status, 200);

    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(events.at(-1).type, "complete");
    assert.equal(events.at(-1).failed, 0);

    return events;
  }

  assert.ok(testFolds(await comparison()).length > 0);
  let settings = await openSettings(ctx);

  const disclosure = settings
    .locator("details")
    .filter({ hasText: "Diff display and AI summaries" });

  assert.equal(await disclosure.getAttribute("open"), null);
  assert.equal(await settings.getByLabel("Collapse test bodies").count(), 0);
  await disclosure.locator("summary").click();
  const toggle = settings.getByLabel("Collapse test bodies", { exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), true);
  await toggle.click();
  await ctx.until(
    async () =>
      (await ctx.apiOk("/diffr-config")).values.plugins.bundled["test-bodies"]
        .enabled === false,
    "diffr persisted the setting",
  );
  await settings
    .getByRole("button", { name: "Reload window", exact: true })
    .waitFor();
  await disclosure.locator("summary").click();
  await ctx.page.screenshot({
    path: path.join(ctx.root, "saved-settings.png"),
  });
  const reloaded = ctx.page.waitForEvent("domcontentloaded");
  await settings
    .getByRole("button", { name: "Reload window", exact: true })
    .click();
  await reloaded;
  settings = await openSettings(ctx);
  assert.equal(await settings.locator("details").getAttribute("open"), null);
  await settings
    .locator("summary")
    .filter({ hasText: "Diff display and AI summaries" })
    .click();
  await settings.getByLabel("Collapse test bodies", { exact: true }).waitFor();
  assert.equal(
    await settings
      .getByLabel("Collapse test bodies", { exact: true })
      .isChecked(),
    false,
  );
  assert.equal(
    await settings
      .getByRole("button", { name: "Reload window", exact: true })
      .count(),
    0,
  );
  assert.equal(testFolds(await comparison()).length, 0);
  await ctx.page.screenshot({
    path: path.join(ctx.root, "reloaded-settings.png"),
  });
  ctx.check(
    "diffr controls load on disclosure expansion",
    "settings save to diffr config",
    "reload CTA survives collapsing the disclosure",
    "window reload preserves values and clears the notice",
    "reloaded structural diff reflects the changed plugin setting",
  );
}
