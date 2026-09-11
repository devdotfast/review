import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  type JsonObject,
  type JsonValue,
  type ReviewThreadsCommand,
  ReviewThreadsCommandResponseSchema,
  ReviewThreadsSnapshotResponseSchema,
  type ReviewVerbResponse,
  jsonObject,
} from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { snapshotReviewTree } from "../fixtures/legacy-reviews/legacy-review-fixture";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { createReviewDir } from "../review-home";
import { prepareReviewRepair } from "../review-repair-preparation";
import {
  type ReviewRepairReadyRequest,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import { appendReviewCommentDraft } from "../review-state-store";
import {
  checkReviewThreadDbVersion,
  closeAllReviewThreadStores,
} from "../review-thread-store-backend";
import { reviewVcs } from "../review-vcs";
import { createGlobalReviewServer } from "./desktop-server";
import {
  GlobalReviewDesktopVerbRelay,
  type ReviewDesktopVerbRelay,
} from "./global-verb-relay";

let root: string | undefined;
type DispatchVerb = (
  sessionId: string,
  value: JsonValue,
) => Promise<ReviewVerbResponse>;

let dispatchVerb: DispatchVerb = async () => ({ ok: true });

function recordingRelay(): ReviewDesktopVerbRelay {
  const inner = new GlobalReviewDesktopVerbRelay();
  return {
    get attached() {
      return inner.attached;
    },
    attach: (writer) => inner.attach(writer),
    dispatch: (sessionId, value) => dispatchVerb(sessionId, value),
    acceptResult: (value) => inner.acceptResult(value),
    close: () => inner.close(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
  dispatchVerb = async () => ({ ok: true });
  if (root) await rm(root, { recursive: true, force: true });
});
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
async function fixture(schemaVersion: 4 | 5 = 4) {
  root = await mkdtemp(path.join(tmpdir(), "repair-server-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const source = path.join(root, "source");
  await mkdir(source);
  await reviewVcs.init(source);
  await writeFile(path.join(source, "one.ts"), "export const one = 1;\n");
  const commit = await reviewVcs.seal(source, "source");
  const stored = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    title: "Keep title",
  });
  const record = {
    ...stored.review,
    schemaVersion,
    status: "accepted",
    lastPublishedAt: "2026-09-01T00:00:00Z",
    dismissedAt: schemaVersion === 4 ? "2026-09-01T01:00:00Z" : null,
    viewedAt: "2026-09-01T00:01:00Z",
  };
  await mkdir(path.join(stored.dir, ".bundle", "document"), {
    recursive: true,
  });
  await writeFile(
    path.join(stored.dir, ".bundle", "document", "manifest.json"),
    JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
  );
  await writeFile(
    path.join(stored.dir, ".bundle", "document", "review-document.js"),
    "throw new Error('never execute server');",
  );
  await writeFile(path.join(stored.dir, "review.json"), JSON.stringify(record));
  const oldRevision = await reviewVcs.seal(
    stored.dir,
    "Review publish candidate",
  );
  const expectedRecord = JSON.stringify({
    ...record,
    presentedDocumentRevision: oldRevision,
  });
  await writeFile(path.join(stored.dir, "review.json"), expectedRecord);
  const expectedFingerprint = await fingerprintReviewRepairInputs(stored.dir);
  const stagingDir = path.join(root, "stage");
  await cp(stored.dir, stagingDir, { recursive: true });
  const normalized = {
    ...record,
    schemaVersion: 5,
    presentedDocumentRevision: oldRevision,
  };
  await writeFile(
    path.join(stagingDir, "review.json"),
    JSON.stringify(normalized),
  );
  await writeReviewDocumentBundle(
    stagingDir,
    bundleReviewDocument({
      format: "review-document/1",
      title: "Repaired",
      routePath: "/",
      sourcePath: "review.mdx",
      body: [],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    }),
  );
  const newDocumentRevision = await reviewVcs.seal(
    stagingDir,
    "Repair current Review document",
  );
  await writeFile(
    path.join(stagingDir, "review.json"),
    JSON.stringify({
      ...normalized,
      presentedDocumentRevision: newDocumentRevision,
    }),
  );
  const request: ReviewRepairReadyRequest = {
    reviewUuid: record.uuid,
    stagingDir,
    expectedRecord,
    expectedFingerprint,
    newDocumentRevision,
    newMapRevision: null,
    sourceFallback: { document: false, map: false },
  };
  const visible = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    title: "Visible review",
  });
  await writeReviewDocumentBundle(
    visible.dir,
    bundleReviewDocument({
      format: "review-document/1",
      title: "Visible",
      routePath: "/",
      sourcePath: "review.mdx",
      body: [],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    }),
  );
  const visibleRevision = await reviewVcs.seal(
    visible.dir,
    "Review publish candidate",
  );
  await writeFile(
    path.join(visible.dir, "review.json"),
    JSON.stringify({
      ...visible.review,
      presentedDocumentRevision: visibleRevision,
    }),
  );
  const token = "repair-secret";
  const server = createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(root, "desktop.json"),
    relay: recordingRelay(),
  });
  await server.listen();
  const post = (
    route: string,
    body: ReviewRepairReadyRequest | ReviewThreadsCommand | JsonObject,
  ) =>
    fetch(`${server.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": token },
      body: JSON.stringify(body),
    });
  const list = () =>
    fetch(`${server.url}/sessions`, {
      headers: { "x-review-token": token },
    }).then((response) => response.json());
  const get = (route: string) =>
    fetch(`${server.url}${route}`, { headers: { "x-review-token": token } });
  return { stored, record, request, server, post, list, visible, get };
}

it.each(["success", "mount-failure", "live-change", "stage-change"])(
  "repairs a legacy database with the document only after mount validation: %s",
  async (outcome) => {
    const { stored, server, post, get } = await fixture();
    const reviewPath = path.join(stored.dir, "review.mdx");
    appendReviewCommentDraft(reviewPath, {
      threadId: "preserved-draft",
      messageId: "preserved-message",
      target: { kind: "document" },
      body: "Keep this draft",
      author: "Reviewer",
    });
    closeAllReviewThreadStores();
    const db = new DatabaseSync(path.join(stored.dir, "review.db"));
    db.prepare(
      "UPDATE meta SET value = '5' WHERE key = 'schema_version'",
    ).run();
    db.close();
    const before = await snapshotReviewTree(stored.dir);
    let expectedAfterFailure = before;
    const prepared = await prepareReviewRepair({ reviewDir: stored.dir });
    if (prepared.kind !== "prepared") throw new Error("Expected legacy repair");
    expect(prepared.request.expectedThreadDbFingerprint).toBeDefined();
    expect(prepared.request.sourceFallback.document).toBe(true);
    let validated = false;
    let refreshedDraftIds: string[] | undefined;
    dispatchVerb = async (sessionId, value) => {
      if (jsonObject(value)?.name !== "validateCanvasMount")
        return { ok: true };
      const prefix = `/sessions/${sessionId}/__progressive-review`;
      expect((await get(`${prefix}/session`)).status).toBe(200);
      const response = await get(`${prefix}/comments`);
      expect(response.status).toBe(200);
      const snapshot = ReviewThreadsSnapshotResponseSchema.parse(
        await response.json(),
      );
      if (!snapshot.ok) throw new Error(snapshot.error);
      expect(Object.keys(snapshot.snapshot.drafts)).toEqual([
        "preserved-draft",
      ]);
      const duringMount = await snapshotReviewTree(stored.dir);
      expect(
        Object.fromEntries(
          Object.entries(duringMount).filter(
            ([name]) => !name.startsWith(".build/"),
          ),
        ),
      ).toEqual(before);
      if (outcome === "live-change" || outcome === "stage-change") {
        const changedDir =
          outcome === "live-change" ? stored.dir : prepared.request.stagingDir;
        if (outcome === "stage-change") {
          appendReviewCommentDraft(path.join(changedDir, "review.mdx"), {
            threadId: "concurrent-draft",
            messageId: "concurrent-message",
            target: { kind: "document" },
            body: "Concurrent staged draft",
            author: "Reviewer",
          });
          const refreshed = ReviewThreadsSnapshotResponseSchema.parse(
            await (await get(`${prefix}/comments`)).json(),
          );
          if (!refreshed.ok) throw new Error(refreshed.error);
          refreshedDraftIds = Object.keys(refreshed.snapshot.drafts).sort();
        } else {
          const changed = new DatabaseSync(path.join(changedDir, "review.db"));
          changed
            .prepare(
              "INSERT INTO meta (key, value) VALUES ('concurrent-change', 'keep')",
            )
            .run();
          changed.close();
        }
        if (outcome === "live-change") {
          const latest = await snapshotReviewTree(stored.dir);
          expectedAfterFailure = Object.fromEntries(
            Object.entries(latest).filter(
              ([name]) => !name.startsWith(".build/"),
            ),
          );
        }
      }
      expect(refreshedDraftIds).toEqual(
        outcome === "stage-change"
          ? ["concurrent-draft", "preserved-draft"]
          : undefined,
      );
      validated = true;
      return outcome === "mount-failure"
        ? { ok: false, error: "test mount failure" }
        : { ok: true };
    };
    try {
      const response = await post("/repair-ready", prepared.request);
      expect(validated).toBe(true);
      expect(response.status).toBe(
        outcome === "success" ? 201 : outcome === "mount-failure" ? 422 : 400,
      );
      if (outcome !== "success") {
        await expectReviewTree(stored.dir, expectedAfterFailure);
        return;
      }
      checkReviewThreadDbVersion(reviewPath);
      const { sessionId } = await response.json();
      const prefix = `/sessions/${sessionId}/__progressive-review`;
      const snapshot = ReviewThreadsSnapshotResponseSchema.parse(
        await (await get(`${prefix}/comments`)).json(),
      );
      if (!snapshot.ok) throw new Error(snapshot.error);
      expect(Object.keys(snapshot.snapshot.drafts)).toEqual([
        "preserved-draft",
      ]);
      const created = await post(`${prefix}/thread-commands`, {
        command: "comment.create",
        mutationId: "after-legacy-repair",
        input: {
          threadId: "new-thread",
          messageId: "new-message",
          target: { kind: "document" },
          body: "Works after repair",
        },
      });
      expect(created.status).toBe(200);
    } finally {
      await server.close();
      await prepared.cleanup();
    }
  },
);

it("switches repaired comments to live snapshots for resynchronization after promotion", async () => {
  const { stored, record, request, server, post, get } = await fixture(5);
  const comment = (index: number): ReviewThreadsCommand => ({
    command: "comment.create",
    mutationId: `repair-message-${index}`,
    input: {
      threadId: `repair-thread-${index}`,
      messageId: `repair-message-${index}`,
      target: { kind: "document" },
      body: `Repair comment ${index}`,
    },
  });
  const validationReads: Array<{ writeStatus: number; revision: number }> = [];
  dispatchVerb = async (sessionId, value) => {
    if (jsonObject(value)?.name !== "validateCanvasMount") return { ok: true };
    const before = await snapshotReviewTree(stored.dir);
    const prefix = `/sessions/${sessionId}/__progressive-review`;
    const snapshot = ReviewThreadsSnapshotResponseSchema.parse(
      await (await get(`${prefix}/comments`)).json(),
    );
    if (!snapshot.ok) throw new Error(snapshot.error);
    const blocked = await post(`${prefix}/thread-commands`, comment(0));
    validationReads.push({
      writeStatus: blocked.status,
      revision: snapshot.snapshot.revision,
    });
    expect(await snapshotReviewTree(stored.dir)).toEqual(before);
    return { ok: true };
  };
  try {
    const repaired = await post("/repair-ready", request);
    expect(repaired.status).toBe(201);
    expect(validationReads).toEqual([{ writeStatus: 409, revision: 0 }]);
    const { sessionId } = await repaired.json();
    const prefix = `/sessions/${sessionId}/__progressive-review`;
    const liveThreads = async () => {
      const snapshot = ReviewThreadsSnapshotResponseSchema.parse(
        await (await get(`${prefix}/comments`)).json(),
      );
      if (!snapshot.ok) throw new Error(snapshot.error);
      return {
        revision: snapshot.snapshot.revision,
        threadIds: Object.keys(snapshot.snapshot.comments),
      };
    };
    // The promoted session must own a fresh live store: revision 0, no
    // carried-over threads, and one revision per accepted mutation.
    expect(await liveThreads()).toEqual({ revision: 0, threadIds: [] });
    const revisions: number[] = [];
    for (const index of [1, 2, 3]) {
      const response = await post(`${prefix}/thread-commands`, comment(index));
      expect(response.status).toBe(200);
      const result = ReviewThreadsCommandResponseSchema.parse(
        await response.json(),
      );
      if (!result.ok) throw new Error(result.error);
      revisions.push(result.commit.revision);
      expect(await liveThreads()).toEqual({
        revision: result.commit.revision,
        threadIds: Array.from(
          { length: index },
          (_unused, offset) => `repair-thread-${offset + 1}`,
        ),
      });
    }
    expect(revisions).toEqual([1, 2, 3]);

    const historical = await post(`/reviews/${record.uuid}/open`, {
      revision: JSON.parse(request.expectedRecord).presentedDocumentRevision,
    });
    expect(historical.status).toBe(201);
    const historicalPrefix = `/sessions/${(await historical.json()).sessionId}/__progressive-review`;
    const beforeHistoricalRead = await snapshotReviewTree(stored.dir);
    const historicalSnapshot = ReviewThreadsSnapshotResponseSchema.parse(
      await (await get(`${historicalPrefix}/comments`)).json(),
    );
    if (!historicalSnapshot.ok) throw new Error(historicalSnapshot.error);
    expect(historicalSnapshot.snapshot.revision).toBe(0);
    expect(
      (await post(`${historicalPrefix}/thread-commands`, comment(4))).status,
    ).toBe(409);
    expect(await snapshotReviewTree(stored.dir)).toEqual(beforeHistoricalRead);
  } finally {
    await server.close();
  }
});

it.each([true, false])(
  "replaces only the repaired current-schema session when mount succeeds: %s",
  async (mountSucceeds) => {
    const { stored, record, request, server, post, list, get } =
      await fixture(5);
    dispatchVerb = async (_sessionId, value) =>
      jsonObject(value)?.name === "validateCanvasMount" && !mountSucceeds
        ? { ok: false, error: "test mount failure" }
        : { ok: true };
    try {
      const opened = await post(`/reviews/${record.uuid}/open`, {});
      expect(opened.status).toBe(201);
      const old = await opened.json();
      const document = await get(
        `/sessions/${old.sessionId}/__progressive-review/document`,
      );
      expect(document.status).toBe(409);
      expect(await document.json()).toMatchObject({
        detail: { code: "needs_republish" },
      });
      const response = await post("/repair-ready", request);
      const result = await response.json();
      expect(response.status).toBe(mountSucceeds ? 201 : 422);
      expect(
        (await list()).items.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual([mountSucceeds ? result.sessionId : old.sessionId]);
      const expectedRecord = JSON.parse(request.expectedRecord);
      if (mountSucceeds)
        expectedRecord.presentedDocumentRevision = request.newDocumentRevision;
      expect(
        JSON.parse(
          await readFile(path.join(stored.dir, "review.json"), "utf8"),
        ),
      ).toEqual(expectedRecord);
      expect(
        (await fingerprintReviewRepairInputs(stored.dir)) ===
          request.expectedFingerprint,
      ).toBe(!mountSucceeds);
    } finally {
      await server.close();
    }
  },
);

it.each([
  "success",
  "mount-failure",
  "concurrent-edit",
  "changed-pins",
  "staging-link",
] as const)(
  "repair server preserves lifecycle and visible session on %s",
  async (outcome) => {
    const { stored, record, request, server, post, list, visible, get } =
      await fixture();
    if (outcome === "changed-pins") {
      const recordPath = path.join(request.stagingDir, "review.json");
      const finalRecord = JSON.parse(await readFile(recordPath, "utf8"));
      await writeFile(
        recordPath,
        JSON.stringify({ ...finalRecord, baseCommit: "f".repeat(40) }),
      );
      request.newDocumentRevision = await reviewVcs.seal(
        request.stagingDir,
        "Bad changed pins",
      );
      await writeFile(
        recordPath,
        JSON.stringify({
          ...finalRecord,
          presentedDocumentRevision: request.newDocumentRevision,
        }),
      );
    }
    if (outcome === "staging-link") {
      const index = path.join(request.stagingDir, ".git", "index");
      await rm(index);
      await symlink("HEAD", index);
    }
    const validationReads: Array<{ status: number; record: string }> = [];
    dispatchVerb = async (sessionId, value) => {
      if (jsonObject(value)?.name === "validateCanvasMount") {
        const versions = await get(
          `/sessions/${sessionId}/__progressive-review/revisions`,
        );
        validationReads.push({
          status: versions.status,
          record: await readFile(path.join(stored.dir, "review.json"), "utf8"),
        });
        if (outcome === "mount-failure")
          return { ok: false, error: "test mount failure" };
        if (outcome === "concurrent-edit")
          await writeFile(
            path.join(stored.dir, "data.ts"),
            "export const concurrent = true;\n",
          );
      }
      return { ok: true };
    };
    try {
      const failedOpen = await post(`/reviews/${record.uuid}/open`, {});
      expect(failedOpen.status).toBe(409);
      expect(await failedOpen.json()).toMatchObject({
        code: "repair_required",
      });
      const opened = await post(`/reviews/${visible.review.uuid}/open`, {});
      expect(opened.status).toBe(201);
      const old = await opened.json();
      const response = await post("/repair-ready", request);
      const result = await response.json();
      const success = outcome === "success";
      expect(validationReads).toEqual(
        outcome === "changed-pins" || outcome === "staging-link"
          ? []
          : [{ status: 200, record: request.expectedRecord }],
      );
      const errorMessage = expect.any(String);
      expect(response.status).toBe(
        success
          ? 201
          : outcome === "mount-failure" || outcome === "changed-pins"
            ? 422
            : 400,
      );
      expect(result).toMatchObject(
        success
          ? {
              ok: true,
              status: "accepted",
              newDocumentRevision: request.newDocumentRevision,
            }
          : { ok: false, error: errorMessage },
      );
      expect(
        JSON.parse(
          await readFile(path.join(stored.dir, "review.json"), "utf8"),
        ),
      ).toEqual(
        success
          ? {
              ...JSON.parse(request.expectedRecord),
              schemaVersion: 5,
              presentedDocumentRevision: request.newDocumentRevision,
            }
          : JSON.parse(request.expectedRecord),
      );
      expect(
        (await list()).items.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual(
        expect.arrayContaining(
          success ? [result.sessionId, old.sessionId] : [old.sessionId],
        ),
      );
      expect((await list()).items).toHaveLength(success ? 2 : 1);
      if (outcome === "concurrent-edit")
        await writeFile(path.join(stored.dir, "data.ts"), "export {};\n");
      expect(
        (await fingerprintReviewRepairInputs(stored.dir)) ===
          request.expectedFingerprint,
      ).toBe(!success);
    } finally {
      await server.close();
    }
  },
);

async function expectReviewTree(
  dir: string,
  expected: Awaited<ReturnType<typeof snapshotReviewTree>>,
) {
  expect(await snapshotReviewTree(dir)).toEqual(expected);
}
