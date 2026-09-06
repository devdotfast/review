import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  "makes the %s candidate transaction wait for the mutation lock",
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
    const writing = withReviewMutationLock(root, () =>
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
          ),
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

it("reports retryable contention and succeeds after the holder releases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-busy-lock-"));
  roots.push(root);
  const entered = deferred();
  const release = deferred();
  const holding = withReviewMutationLock(root, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await expect(
      withReviewMutationLock(root, async () => "overlap", { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      name: "ReviewBusyError",
      code: "REVIEW_BUSY",
      retryable: true,
      reviewUuid: path.basename(root),
      message: expect.stringContaining(
        "Retry after its current operation completes",
      ),
    });
  } finally {
    release.resolve();
    await holding;
  }
  await expect(
    withReviewMutationLock(root, async () => "retried"),
  ).resolves.toBe("retried");
});

it("does not steal a healthy cross-process lock when its wait expires", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "review-busy-process-"));
  roots.push(parent);
  const root = path.join(parent, "review");
  await mkdir(root);
  const lockPath = `${root}.mutation-lock`;
  const script = path.join(parent, "holder.mjs");
  await writeFile(
    script,
    `import { mkdir, writeFile, rm } from "node:fs/promises";
const lockPath = process.argv[2];
await mkdir(lockPath);
await writeFile(lockPath + "/owner.json", JSON.stringify({ pid: process.pid }));
process.stdout.write("ready");
process.stdin.resume();
process.stdin.once("data", async () => { await rm(lockPath, { recursive: true }); process.exit(0); });
`,
  );
  const child = spawn(process.execPath, [script, lockPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    await expect(
      withReviewMutationLock(root, async () => "overlap", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "REVIEW_BUSY", retryable: true });
    expect(
      JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).pid,
    ).toBe(child.pid);
  } finally {
    child.stdin.end("release");
    await exited;
  }
  await expect(
    withReviewMutationLock(root, async () => "retried"),
  ).resolves.toBe("retried");
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
