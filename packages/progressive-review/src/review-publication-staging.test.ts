import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { markReviewViewed } from "./review-attention";
import {
  readReviewDocumentBundle,
  reviewDocumentBundleData,
} from "./review-bundle";
import { createReviewDir, materializeReviewRevision } from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { prepareReviewDocumentBundle } from "./review-publication-preparation";
import {
  sealReviewDocumentPublication,
  stageReviewDocumentPublication,
} from "./review-publication-staging";
import { appendReviewComment, readReviewComments } from "./review-state-store";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import { reviewVcs } from "./review-vcs";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("prepares outside the live lock while preserving viewed and comment updates", async () => {
  const { review, home } = await fixture();
  const dependency = path.join(
    home,
    "reviews/node_modules/review-staging-dependency",
  );
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({
      name: "review-staging-dependency",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  await writeFile(
    path.join(dependency, "index.js"),
    'export const label = "dependency label";',
  );
  await writeFile(
    path.join(dependency, "index.d.ts"),
    "export declare const label: string;",
  );
  await writeFile(
    path.join(review.dir, "data.ts"),
    'export { label } from "review-staging-dependency";',
  );
  const entered = deferred<string>();
  const release = deferred<void>();
  const staging = stageReviewDocumentPublication({
    review,
    prepareDocument: async (input) => {
      entered.resolve(input.review.dir);
      await release.promise;
      return prepareReviewDocumentBundle(input);
    },
  });
  const stagingDir = await entered.promise;
  try {
    await markReviewViewed(review, new Date("2026-09-05T12:00:00Z"));
    await withReviewMutationLock(
      review.dir,
      async () => {
        appendReviewComment(path.join(review.dir, "review.mdx"), {
          threadId: "during-compile",
          messageId: "message",
          target: { kind: "document" },
          body: "Preserve this",
          author: "Reviewer",
        });
      },
      { timeoutMs: 100 },
    );
  } finally {
    release.resolve();
  }
  const document = await staging;
  expect(existsSync(stagingDir)).toBe(false);
  expect(existsSync(path.join(review.dir, ".bundle"))).toBe(false);
  expect(JSON.stringify(reviewDocumentBundleData(document.bundle))).toContain(
    "dependency label",
  );
  const revision = await sealReviewDocumentPublication({ review, document });
  const materialized = path.join(home, "presented");
  await materializeReviewRevision(review.dir, revision, materialized);
  expect(
    JSON.parse(await readFile(path.join(review.dir, "review.json"), "utf8"))
      .viewedAt,
  ).toBe("2026-09-05T12:00:00.000Z");
  expect(
    readReviewComments(path.join(review.dir, "review.mdx"))["during-compile"]
      .messages,
  ).toHaveLength(1);
  const materializedBundle = await readReviewDocumentBundle(materialized, "/");
  if (!materializedBundle) throw new Error("Missing materialized bundle");
  expect(reviewDocumentBundleData(materializedBundle)).toEqual(
    reviewDocumentBundleData(document.bundle),
  );
});

it("resolves Review-local pnpm dependencies without copying their symlinks", async () => {
  const { review } = await fixture();
  const modules = path.join(review.dir, "node_modules");
  const dependency = path.join(
    modules,
    ".pnpm/review-local@1.0.0/node_modules/review-local",
  );
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({
      name: "review-local",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  await writeFile(
    path.join(dependency, "index.js"),
    'export const label = "local pnpm dependency";',
  );
  await writeFile(
    path.join(dependency, "index.d.ts"),
    "export declare const label: string;",
  );
  await symlink(
    dependency,
    path.join(modules, "review-local"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(
    path.join(review.dir, "data.ts"),
    'export { label } from "review-local";',
  );
  const document = await stageReviewDocumentPublication({ review });
  expect(JSON.stringify(reviewDocumentBundleData(document.bundle))).toContain(
    "local pnpm dependency",
  );
  expect(await readFile(path.join(dependency, "index.js"), "utf8")).toContain(
    "local pnpm dependency",
  );
  const revision = await sealReviewDocumentPublication({ review, document });
  expect(revision).toMatch(/^[a-f0-9]{40}$/);
});

it("rejects changed authoring before writing bundles or sealing private history", async () => {
  const { review } = await fixture();
  const document = await stageReviewDocumentPublication({ review });
  await writeFile(
    path.join(review.dir, "data.ts"),
    'export const label = "new draft";',
  );
  await expect(
    sealReviewDocumentPublication({ review, document }),
  ).rejects.toThrow("authoring changed");
  expect(await reviewVcs.log(review.dir)).toEqual([]);
  expect(existsSync(path.join(review.dir, ".bundle"))).toBe(false);
  expect(await readFile(path.join(review.dir, "data.ts"), "utf8")).toContain(
    "new draft",
  );
});

it.each([
  { sourceCommit: "b".repeat(40) },
  { baseRef: "other" },
  { worktreePath: "/different/source" },
  { sourceIdentity: { kind: "git-branch", name: "other" } },
])(
  "rechecks presentation pins %j before committing a staged publication",
  async (changed) => {
    const { review } = await fixture();
    const document = await stageReviewDocumentPublication({ review });
    await writeFile(
      path.join(review.dir, "review.json"),
      JSON.stringify({ ...review.review, ...changed }),
    );
    await expect(
      sealReviewDocumentPublication({ review, document }),
    ).rejects.toThrow("Review changed while preparing publication");
    expect(await reviewVcs.log(review.dir)).toEqual([]);
    expect(existsSync(path.join(review.dir, ".bundle"))).toBe(false);
  },
);

it("rechecks new open threads before sealing a prepared republication", async () => {
  const fixtureValue = await fixture();
  const review = {
    ...fixtureValue.review,
    review: {
      ...fixtureValue.review.review,
      presentedDocumentRevision: "a".repeat(40),
    },
  };
  await writeFile(
    path.join(review.dir, "review.json"),
    JSON.stringify(review.review),
  );
  const document = await stageReviewDocumentPublication({ review });
  appendReviewComment(path.join(review.dir, "review.mdx"), {
    threadId: "new-thread",
    messageId: "message",
    target: { kind: "document" },
    body: "Review this",
    author: "Reviewer",
  });
  await expect(
    sealReviewDocumentPublication({ review, document }),
  ).rejects.toMatchObject({ code: "review_open_threads" });
  expect(await reviewVcs.log(review.dir)).toEqual([]);
  expect(existsSync(path.join(review.dir, ".bundle"))).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "refuses authoring symlinks instead of following mutable external inputs",
  async () => {
    const { review, home } = await fixture();
    const external = path.join(home, "external.ts");
    await writeFile(external, 'export const label = "external";');
    await rm(path.join(review.dir, "data.ts"));
    await symlink(external, path.join(review.dir, "data.ts"));
    await expect(stageReviewDocumentPublication({ review })).rejects.toThrow(
      "symbolic link",
    );
    expect(await readFile(external, "utf8")).toContain("external");
    expect(await reviewVcs.log(review.dir)).toEqual([]);
  },
);

async function fixture() {
  const home = await mkdtemp(
    path.join(tmpdir(), "review-publication-staging-"),
  );
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const root = path.join(home, "source");
  await mkdir(root);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]);
  const review = await createReviewDir({
    worktreePath: root,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  await writeFile(
    path.join(review.dir, "review.mdx"),
    'import { label } from "./data";\n\n# Staged document\n\n{label}\n',
  );
  await writeFile(
    path.join(review.dir, "data.ts"),
    'export const label = "original";',
  );
  return { home, review };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
