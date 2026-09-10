import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import {
  REVIEW_ARTIFACTS_DIR,
  readReviewDocumentArtifact,
} from "./review-artifact-store";
import { markReviewViewed } from "./review-attention";
import {
  readReviewDocumentBundle,
  reviewDocumentBundleData,
} from "./review-bundle";
import { createReviewDir } from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import {
  prepareReviewDocumentCandidate,
  stageReviewDocumentPublication,
} from "./review-publication-staging";
import { listPublications, putReviewRecord } from "./review-state-db";
import { appendReviewComment, readReviewComments } from "./review-state-store";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import {
  mutateLiveDocument,
  readLiveBundle,
  readLiveSnapshot,
} from "./server/review-live-authoring";

const roots: string[] = [];

it("compiles rich live MDX with native data, rejects invalid edits, and recovers its projection", async () => {
  const { review } = await fixture();
  const initial = await readLiveSnapshot(review);
  const snapshot = await withReviewMutationLock(review.dir, () =>
    mutateLiveDocument(review, {
      reviewUuid: review.review.uuid,
      mutationId: randomUUID(),
      expectedSourceHash: initial.sourceHash,
      operation: {
        type: "replace",
        nodes: [
          { id: "title", source: "# Native live review\n\n{data.label}" },
          {
            id: "diagram",
            source:
              '<SequenceDiagram label="Flow" messages={[{from: {label: "Agent"}, to: {label: "Desktop"}, label: "Author", code: "api.edit()"}]} />',
          },
        ],
      },
    }),
  );
  expect(snapshot).toMatchObject({ mode: "incremental", revision: 1 });
  const bundle = await readLiveBundle(review);
  expect(bundle).not.toBeNull();
  const document = reviewDocumentBundleData(bundle!);
  expect(JSON.stringify(document)).toContain('"name":"SequenceDiagram"');
  expect(JSON.stringify(document)).toContain('"id":"review-node-diagram"');
  expect(JSON.stringify(document)).toContain("original");
  expect(await readReviewDocumentBundle(review.dir, "/")).toBeNull();
  await expect(
    withReviewMutationLock(review.dir, () =>
      mutateLiveDocument(review, {
        reviewUuid: review.review.uuid,
        mutationId: randomUUID(),
        expectedSourceHash: snapshot.sourceHash,
        operation: {
          type: "update",
          node: { id: "diagram", source: '<SequenceDiagram typo="broken" />' },
        },
      }),
    ),
  ).rejects.toThrow("Property 'typo' does not exist");
  expect(await readLiveSnapshot(review)).toEqual(snapshot);
  // A raw data.ts edit invalidates the cached native projection.
  await writeFile(
    path.join(review.dir, "data.ts"),
    'export const label = "updated data";',
  );
  expect((await readLiveBundle(review))?.json).toContain("updated data");
}, 30_000);
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
  const holderReady = Promise.withResolvers<void>();
  const beginUpdates = Promise.withResolvers<void>();
  const updatesComplete = Promise.withResolvers<void>();
  const releaseHolder = Promise.withResolvers<void>();
  let holderReleased = false;
  const holder = withReviewMutationLock(review.dir, async () => {
    holderReady.resolve();
    await beginUpdates.promise;
    await markReviewViewed(review, new Date("2026-09-05T12:00:00Z"));
    appendReviewComment(path.join(review.dir, "review.mdx"), {
      threadId: "during-compile",
      messageId: "message",
      target: { kind: "document" },
      body: "Preserve this",
      author: "Reviewer",
    });
    updatesComplete.resolve();
    await releaseHolder.promise;
    holderReleased = true;
  });
  let staging: ReturnType<typeof stageReviewDocumentPublication> | undefined;
  let document!: Awaited<ReturnType<typeof stageReviewDocumentPublication>>;
  let stagingDir!: string;
  try {
    await Promise.race([holderReady.promise, holder]);
    staging = stageReviewDocumentPublication({ review });
    stagingDir = await waitForStagingCopy(path.dirname(review.dir));
    beginUpdates.resolve();
    await Promise.race([updatesComplete.promise, holder]);
    document = await staging;
    expect(holderReleased).toBe(false);
  } finally {
    beginUpdates.resolve();
    releaseHolder.resolve();
    if (staging) await Promise.allSettled([staging]);
    await holder;
  }
  expect(existsSync(stagingDir)).toBe(false);
  expect(existsSync(path.join(review.dir, ".bundle"))).toBe(false);
  expect(JSON.stringify(reviewDocumentBundleData(document.bundle))).toContain(
    "dependency label",
  );
  const candidate = await prepareReviewDocumentCandidate({ review, document });
  expect(
    JSON.parse(await readFile(path.join(review.dir, "review.json"), "utf8"))
      .viewedAt,
  ).toBe("2026-09-05T12:00:00.000Z");
  expect(
    readReviewComments(path.join(review.dir, "review.mdx"))["during-compile"]
      .messages,
  ).toHaveLength(1);
  // The candidate is only bytes in the store: nothing points at it yet.
  expect(listPublications(review.dir, "document")).toEqual([]);
  const installed = await readReviewDocumentArtifact(
    review.dir,
    candidate.artifactHash,
  );
  if (!installed) throw new Error("Missing installed document artifact");
  expect(reviewDocumentBundleData(installed)).toEqual(
    reviewDocumentBundleData(document.bundle),
  );
  expect(candidate.title).toBe("Staged document");
}, 15_000);

/** The staging copy lands in a `.review-publish-` sibling of the review dir. */
async function waitForStagingCopy(reviewsDir: string): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt++) {
    for (const name of await readdir(reviewsDir)) {
      const candidate = path.join(reviewsDir, name);
      if (
        name.startsWith(".review-publish-") &&
        existsSync(path.join(candidate, "review.mdx"))
      )
        return candidate;
    }
    await setTimeout(10);
  }
  throw new Error("Publication staging never copied the review.");
}

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
  const candidate = await prepareReviewDocumentCandidate({ review, document });
  expect(candidate.artifactHash).toMatch(/^[a-f0-9]{64}$/);
});

it("takes the mutation lock around candidate install", async () => {
  const { review } = await fixture();
  const document = await stageReviewDocumentPublication({ review });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withReviewMutationLock(review.dir, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let finished = false;
  const preparing = prepareReviewDocumentCandidate({ review, document }).then(
    (candidate) => {
      finished = true;
      return candidate.artifactHash;
    },
  );
  for (let attempt = 0; attempt < 30; attempt++) await setImmediate();
  const bypassed = finished;
  expect(existsSync(path.join(review.dir, REVIEW_ARTIFACTS_DIR))).toBe(false);
  release.resolve();
  await holding;
  await expect(preparing).resolves.toMatch(/^[a-f0-9]{64}$/);
  expect(bypassed).toBe(false);
});

it("rejects changed authoring before installing an artifact", async () => {
  const { review } = await fixture();
  const document = await stageReviewDocumentPublication({ review });
  await writeFile(
    path.join(review.dir, "data.ts"),
    'export const label = "new draft";',
  );
  await expect(
    prepareReviewDocumentCandidate({ review, document }),
  ).rejects.toThrow("authoring changed");
  expect(existsSync(path.join(review.dir, REVIEW_ARTIFACTS_DIR))).toBe(false);
  expect(listPublications(review.dir, "document")).toEqual([]);
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
    // The database is authoritative for the guard: a concurrent pin change
    // lands there, not in the review.json mirror.
    putReviewRecord(review.dir, { ...review.review, ...changed });
    await expect(
      prepareReviewDocumentCandidate({ review, document }),
    ).rejects.toThrow("Review changed while preparing publication");
    expect(existsSync(path.join(review.dir, REVIEW_ARTIFACTS_DIR))).toBe(false);
    expect(listPublications(review.dir, "document")).toEqual([]);
  },
);

it("rechecks new open threads before installing a prepared republication", async () => {
  const fixtureValue = await fixture();
  const review = {
    ...fixtureValue.review,
    review: {
      ...fixtureValue.review.review,
      presentedDocumentRevision: "a".repeat(40),
    },
  };
  putReviewRecord(review.dir, review.review);
  const document = await stageReviewDocumentPublication({ review });
  appendReviewComment(path.join(review.dir, "review.mdx"), {
    threadId: "new-thread",
    messageId: "message",
    target: { kind: "document" },
    body: "Review this",
    author: "Reviewer",
  });
  await expect(
    prepareReviewDocumentCandidate({ review, document }),
  ).rejects.toMatchObject({ code: "review_open_threads" });
  expect(existsSync(path.join(review.dir, REVIEW_ARTIFACTS_DIR))).toBe(false);
  expect(listPublications(review.dir, "document")).toEqual([]);
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
    expect(existsSync(path.join(review.dir, REVIEW_ARTIFACTS_DIR))).toBe(false);
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
