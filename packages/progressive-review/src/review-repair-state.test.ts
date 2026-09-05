import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "./review-repair-state";
import { appendReviewCommentDraft } from "./review-state-store";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";

let root: string | undefined;
afterEach(async () => {
  closeAllReviewThreadStores();
  if (root) await rm(root, { recursive: true, force: true });
});
it("fingerprints editable inputs and blocks pending agent writes without changing threads", async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-repair-state-"));
  await writeFile(path.join(root, "review.mdx"), "# One");
  const before = await fingerprintReviewRepairInputs(root);
  await writeFile(path.join(root, "review.mdx"), "# Two");
  expect(await fingerprintReviewRepairInputs(root)).not.toBe(before);
  assertNoActiveReviewAgentWrites(root);
  appendReviewCommentDraft(path.join(root, "review.mdx"), {
    threadId: "thread",
    messageId: "message",
    target: { kind: "document" },
    body: "Update",
    author: "Reviewer",
    agentInput: true,
  });
  closeAllReviewThreadStores();
  const bytes = await readFile(path.join(root, "review.db"));
  expect(() => assertNoActiveReviewAgentWrites(root!)).toThrow("pending agent");
  expect(await readFile(path.join(root, "review.db"))).toEqual(bytes);
});
