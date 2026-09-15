import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { fingerprintReviewRepairInputs } from "./review-repair-state";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("fingerprints editable inputs", async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-repair-state-"));
  await writeFile(path.join(root, "review.mdx"), "# One");
  const before = await fingerprintReviewRepairInputs(root);
  await writeFile(path.join(root, "review.mdx"), "# Two");
  expect(await fingerprintReviewRepairInputs(root)).not.toBe(before);
});
