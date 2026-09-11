import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { ensureReviewPinnedCheckout } from "../review-head-checkout";
import { createReviewDir, sealReviewCandidate } from "../review-home";
import { withReviewMutationLock } from "../review-mutation-lock";
import { closeAllReviewThreadStores } from "../review-thread-store-backend";
import { reviewVcs } from "../review-vcs";
import {
  type GlobalReviewServerInput,
  createGlobalReviewServer,
} from "./desktop-server";
import { materializePublishRevision } from "./publish-stage";
import { createReviewSessionHandler } from "./session-handler";

const roots: string[] = [];
afterEach(async () => {
  closeAllReviewThreadStores();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(options: Partial<GlobalReviewServerInput> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "review-register-"));
  roots.push(root);
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const source = path.join(root, "source");
  await mkdir(source);
  await reviewVcs.init(source);
  await writeFile(path.join(source, "one.ts"), "export const one = 1;\n");
  const commit = await reviewVcs.seal(source, "Source");
  const review = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  await writeReviewDocumentBundle(
    review.dir,
    bundleReviewDocument({
      format: "review-document/1",
      title: "Registration",
      routePath: "/",
      sourcePath: "review.mdx",
      body: [],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    }),
  );
  const revision = await sealReviewCandidate(review.dir, "Published");
  await writeFile(
    path.join(review.dir, "review.json"),
    JSON.stringify({
      ...review.review,
      status: "awaiting-review",
      presentedDocumentRevision: revision,
      lastPublishedAt: new Date().toISOString(),
    }),
  );
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token: "test-secret",
    discoveryPath: path.join(root, "desktop.json"),
    ...options,
  });
  await server.listen();
  const request = (route: string, body?: JsonObject) =>
    fetch(`${server.url}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        "x-review-token": "test-secret",
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return {
    server,
    review,
    revision,
    request,
    open: () =>
      request(`/reviews/${review.review.uuid}/open`, { background: true }),
  };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Preparation blocked an independent operation")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("allows another process and a server mutation to acquire the review lock during slow checkout preparation", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const setup = await fixture({
    pinnedCheckoutFactory: async (input) => {
      entered.resolve();
      await release.promise;
      return ensureReviewPinnedCheckout(input);
    },
  });
  const opening = setup.open();
  try {
    await within(entered.promise);
    // Acquire the same atomic directory lock from another process.
    const acquired = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { mkdirSync, writeFileSync, rmSync } from 'node:fs'; const lock = process.argv[1]; mkdirSync(lock); try { writeFileSync(lock + '/owner.json', JSON.stringify({ pid: process.pid })); process.stdout.write('acquired'); } finally { rmSync(lock, { recursive: true }); }`,
        `${setup.review.dir}.mutation-lock`,
      ],
      { encoding: "utf8" },
    );
    expect(acquired).toBe("acquired");
    expect(
      (
        await within(
          setup.request(`/reviews/${setup.review.review.uuid}/dismiss`, {}),
        )
      ).status,
    ).toBe(200);
  } finally {
    release.resolve();
    await opening;
    await setup.server.close();
  }
});

it.each(["stale", "duplicate", "closing"] as const)(
  "disposes unused handlers after %s preparation",
  async (scenario) => {
    let created = 0;
    let closed = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const setup = await fixture({
      sessionHandlerFactory: async (input) => {
        const handler = await createReviewSessionHandler(input);
        created += 1;
        if (created === (scenario === "duplicate" ? 2 : 1)) entered.resolve();
        await release.promise;
        return {
          ...handler,
          close: async () => {
            closed += 1;
            await handler.close();
          },
        };
      },
    });
    const requests = [setup.open()];
    if (scenario === "duplicate") requests.push(setup.open());
    let shutdown: Promise<void> | undefined;
    try {
      await within(entered.promise);
      if (scenario === "stale")
        await withReviewMutationLock(setup.review.dir, async () => {
          const recordPath = path.join(setup.review.dir, "review.json");
          const record = JSON.parse(await readFile(recordPath, "utf8"));
          await writeFile(
            recordPath,
            JSON.stringify({ ...record, baseRef: "changed" }),
          );
        });
      if (scenario === "closing") shutdown = setup.server.close();
      release.resolve();
      const responses = await Promise.all(requests);
      const bodies = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(closed).toBe(1);
      expect(responses.map((response) => response.status)).toEqual(
        scenario === "duplicate" ? [201, 201] : [409],
      );
      const sessionIdMatcher = expect.any(String);
      expect(bodies.map((body) => body.sessionId)).toEqual(
        scenario === "duplicate"
          ? [sessionIdMatcher, bodies[0].sessionId]
          : [undefined],
      );
      expect(bodies.map((body) => body.code)).toEqual(
        scenario === "duplicate"
          ? [undefined, undefined]
          : [scenario === "stale" ? "review_changed" : "server_closing"],
      );
      const installed =
        scenario === "closing"
          ? []
          : (await (await setup.request("/sessions")).json()).items;
      expect(installed).toHaveLength(scenario === "duplicate" ? 1 : 0);
    } finally {
      release.resolve();
      await Promise.allSettled(requests);
      await (shutdown ?? setup.server.close());
    }
  },
);

it("reopens an unavailable revision after materialization recovers without a poisoned cache", async () => {
  let fail = true;
  const setup = await fixture({
    publishRuntime: {
      materializePublishRevision: (input) => {
        if (fail)
          return Promise.reject(new Error("temporary object read failure"));
        return materializePublishRevision(input);
      },
    },
  });
  try {
    const first = await setup.open();
    expect(first.status).toBe(201);
    const firstSession = await first.json();
    const document = await setup.request(
      `/sessions/${firstSession.sessionId}/__progressive-review/document`,
    );
    expect(document.status).toBe(409);
    await expect(
      readFile(
        path.join(setup.review.dir, ".build", setup.revision, "review.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const closed = await fetch(
      `${setup.server.url}/sessions/${firstSession.sessionId}?terminal=false`,
      { method: "DELETE", headers: { "x-review-token": "test-secret" } },
    );
    expect(closed.status).toBe(200);
    fail = false;
    const reopened = await setup.open();
    expect(reopened.status).toBe(201);
    const secondSession = await reopened.json();
    expect(secondSession.sessionId).not.toBe(firstSession.sessionId);
    expect(
      (
        await setup.request(
          `/sessions/${secondSession.sessionId}/__progressive-review/document`,
        )
      ).status,
    ).toBe(200);
  } finally {
    await setup.server.close();
  }
});
