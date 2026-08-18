import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanReviewDesktop, cleanTargets } from "./clean-review-desktop.mjs";

test("cleans generated Desktop artifacts but preserves authored Reviews", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-desktop-clean-"));
  const reviewHome = path.join(root, "review-home");
  const targets = cleanTargets({ root, reviewHome });
  const authoredReview = path.join(
    reviewHome,
    "reviews",
    "example",
    "review.mdx",
  );

  for (const target of targets) {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "generated"), "generated");
  }
  await mkdir(path.dirname(authoredReview), { recursive: true });
  await writeFile(authoredReview, "# Review");

  await cleanReviewDesktop({ root, reviewHome });

  for (const target of targets) {
    assert.equal(await exists(target), false, `${target} should be removed`);
  }
  assert.equal(await exists(authoredReview), true);
});

async function exists(target) {
  try {
    await import("node:fs/promises").then(({ access }) => access(target));
    return true;
  } catch {
    return false;
  }
}
