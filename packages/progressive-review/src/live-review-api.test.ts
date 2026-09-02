import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewApi } from "./live-review-api";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
let reviewHome: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (reviewHome) await rm(reviewHome, { recursive: true, force: true });
  reviewHome = undefined;
});

describe("live Review API", () => {
  it("keeps stable nodes while validating append and replace atomically", async () => {
    reviewHome = await mkdtemp(path.join(tmpdir(), "live-review-api-"));
    vi.stubEnv("DEV_REVIEW_HOME", reviewHome);
    const focusReview = vi.fn(async () => undefined);
    const notifyPageUpdated = vi.fn(async () => undefined);
    const review = createReviewApi(
      { cwd: repoRoot },
      { focusReview, notifyPageUpdated },
    );

    const info = await review.createReview({
      source: { kind: "current-checkout" },
      title: "Sequence diagram tracer",
    });
    expect(info).toMatchObject({ rootNodeId: "root", nodeCount: 1 });
    expect(focusReview).toHaveBeenCalledOnce();

    await expect(
      review.renderMdx({
        targetNodeId: info.rootNodeId,
        mode: "replace",
        mdx: "**Summary**\n\nThe root is lossless MDX.",
      }),
    ).resolves.toMatchObject({ ok: true, nodeId: info.rootNodeId });

    const append = await review.renderMdx({
      targetNodeId: info.rootNodeId,
      mode: "append",
      title: "Desktop health check",
      mdx: '<SequenceDiagram label="Review Desktop health check" messages={[{ from: { label: "Review CLI" }, to: { label: "Review Desktop" }, label: "Verify active instance", anchor: { peek: { file: "packages/progressive-review/src/desktop-discovery.ts", fromLine: 71, toLine: 103 } } }]} />',
    });
    expect(append).toMatchObject({ ok: true });
    if (!append.ok) throw new Error("append unexpectedly failed");

    const child = await review.getNodeInfo({ nodeId: append.nodeId });
    expect(child).toMatchObject({
      id: append.nodeId,
      parentId: info.rootNodeId,
      title: "Desktop health check",
      childIds: [],
    });
    expect(await review.getChildren({ nodeId: info.rootNodeId })).toEqual([
      child,
    ]);

    const beforeRejectedWrite = await review.getBasicInfo();
    const rejected = await review.renderMdx({
      targetNodeId: append.nodeId,
      mode: "replace",
      mdx: "<UnknownComponent />",
    });
    expect(rejected).toMatchObject({ ok: false });
    expect(await review.getNodeInfo({ nodeId: append.nodeId })).toEqual(child);
    expect(await review.getBasicInfo()).toEqual(beforeRejectedWrite);

    await expect(
      review.setReviewStatus({ status: "awaiting-review" }),
    ).resolves.toMatchObject({ status: "awaiting-review" });
    expect(notifyPageUpdated).toHaveBeenCalledTimes(3);
  });
});
