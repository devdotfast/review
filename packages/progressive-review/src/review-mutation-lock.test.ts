import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "./review-bundle";
import { withReviewMutationLock } from "./review-mutation-lock";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(["document", "map"])(
  "makes the %s candidate writer wait for the same mutation lock",
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "review-writer-lock-"));
    roots.push(root);
    const entered = deferred();
    const release = deferred();
    const holding = withReviewMutationLock(root, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let finished = false;
    const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
    const writing = (
      kind === "document"
        ? writeReviewDocumentBundle(
            root,
            bundleReviewDocument({
              format: "review-document/1",
              title: "New",
              routePath: "/",
              sourcePath: "review.mdx",
              body: [],
              anchors: {},
              anchorContents: {},
              softwareModels: [],
            }),
          )
        : writeReviewSoftwareMapBundle(
            root,
            bundleReviewSoftwareMap({
              head: model,
              base: model,
              headCommit: "a".repeat(40),
              baseCommit: "b".repeat(40),
            }),
          )
    ).then(() => {
      finished = true;
    });
    // Let all filesystem writes finish if they incorrectly bypass the held mutex.
    for (let attempt = 0; attempt < 30; attempt++) await setImmediate();
    const bypassed = finished;
    release.resolve();
    await Promise.all([holding, writing]);
    expect(bypassed).toBe(false);
    expect(finished).toBe(true);
  },
);

it("allows nested operations in the same transaction without deadlocking", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-nested-lock-"));
  roots.push(root);
  expect(
    await withReviewMutationLock(root, () =>
      withReviewMutationLock(root, async () => "nested"),
    ),
  ).toBe("nested");
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
