import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  type ReviewThreadsCommand,
  ReviewThreadsCommandResponseSchema,
  ReviewThreadsSnapshotResponseSchema,
  type ReviewVerbResponse,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { snapshotReviewTree } from "../fixtures/legacy-reviews/legacy-review-fixture";
import {
  initLegacyReviewRepo,
  sealLegacyReviewCommit,
} from "../fixtures/legacy-reviews/legacy-review-git";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { createReviewDir, readStoredReview } from "../review-home";
import { parsePublicationRecord } from "../review-publication-record";
import { fingerprintReviewRepairInputs } from "../review-repair-state";
import {
  type ReviewPublicationRow,
  deleteReviewState,
  listPublications,
  putReviewRecord,
  readLegacyArtifactImport,
  readReviewRecord,
} from "../review-state-db";
import { appendReviewCommentDraft } from "../review-state-store";
import {
  checkReviewThreadDbVersion,
  closeAllReviewThreadStores,
  copyReviewThreadDatabaseSnapshot,
} from "../review-thread-store-backend";
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

interface FixtureOptions {
  schemaVersion?: 4 | 5 | 6;
  /** `"broken"` seals JavaScript that cannot be converted, so the Review is
   * only reachable through repair; `"json"` seals a readable v2 bundle. */
  sealedDocument?: "broken" | "json";
  /** Read the Review once, so its Git-era publication becomes a row. */
  imported?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const schemaVersion = options.schemaVersion ?? 4;
  const sealedDocument = options.sealedDocument ?? "broken";
  root = await mkdtemp(path.join(tmpdir(), "repair-server-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  const source = path.join(root, "source");
  await mkdir(source);
  await initLegacyReviewRepo(source);
  await writeFile(path.join(source, "one.ts"), "export const one = 1;\n");
  const commit = await sealLegacyReviewCommit(source, "source");
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
    dismissedAt: schemaVersion === 6 ? null : "2026-09-01T01:00:00Z",
    viewedAt: "2026-09-01T00:01:00Z",
  };
  if (sealedDocument === "broken") {
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
  } else {
    await writeReviewDocumentBundle(
      stored.dir,
      publishedDocument("Keep title"),
    );
  }
  await writeFile(path.join(stored.dir, "review.json"), JSON.stringify(record));
  const oldRevision = await sealLegacyReviewCommit(
    stored.dir,
    "Review publish candidate",
  );
  await writeFile(
    path.join(stored.dir, "review.json"),
    JSON.stringify({ ...record, presentedDocumentRevision: oldRevision }),
  );
  deleteReviewState(stored.dir);
  if (options.imported) await readStoredReview(stored.dir);
  const visible = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    title: "Visible review",
  });
  await writeReviewDocumentBundle(visible.dir, publishedDocument("Visible"));
  const visibleRevision = await sealLegacyReviewCommit(
    visible.dir,
    "Review publish candidate",
  );
  putReviewRecord(visible.dir, {
    ...visible.review,
    presentedDocumentRevision: visibleRevision,
  });
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
  const post = (route: string, body: ReviewThreadsCommand | JsonObject) =>
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
  const repair = () =>
    post("/lifecycle/repair", {
      cwd: stored.review.worktreePath,
      reviewUuid: stored.review.uuid,
    });
  return {
    stored,
    record,
    oldRevision,
    server,
    post,
    list,
    visible,
    get,
    repair,
  };
}

function publishedDocument(title: string) {
  return bundleReviewDocument({
    format: "review-document/1",
    title,
    routePath: "/",
    sourcePath: "review.mdx",
    body: [],
    anchors: {},
    anchorContents: {},
    softwareModels: [],
  });
}

function documentRows(reviewDir: string): ReviewPublicationRow[] {
  return listPublications(reviewDir, "document");
}

/** A refused repair may leave the content-addressed bytes it installed while
 * preparing; nothing references them, so they are not part of "unchanged". */
async function snapshotWithoutArtifacts(dir: string) {
  return Object.fromEntries(
    Object.entries(await snapshotReviewTree(dir)).filter(
      ([name]) => !name.startsWith("artifacts/"),
    ),
  );
}

function presentedDocument(reviewDir: string): string | undefined {
  return jsonString(
    jsonObject(readReviewRecord(reviewDir))?.presentedDocumentRevision,
  );
}

it.each(["success", "mount-failure"])(
  "repairs an unconvertible sealed document only after mount validation: %s",
  async (outcome) => {
    const { stored, server, post, repair, get } = await fixture();
    const reviewPath = path.join(stored.dir, "review.mdx");
    appendReviewCommentDraft(reviewPath, {
      threadId: "preserved-draft",
      messageId: "preserved-message",
      target: { kind: "document" },
      body: "Keep this draft",
      author: "Reviewer",
    });
    closeAllReviewThreadStores();
    copyReviewThreadDatabaseSnapshot(reviewPath, reviewPath);
    // Reading is what migrates this Review's metadata and threads; its sealed
    // document cannot be converted, so it stays a repair candidate.
    expect("error" in (await readStoredReview(stored.dir))).toBe(true);
    expect(documentRows(stored.dir)).toEqual([]);
    const before = await snapshotWithoutArtifacts(stored.dir);
    let validated = false;
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
      // Nothing is committed until the mount is clean.
      expect(documentRows(stored.dir)).toEqual([]);
      validated = true;
      return outcome === "mount-failure"
        ? { ok: false, error: "test mount failure" }
        : { ok: true };
    };
    try {
      const success = outcome === "success";
      const response = await repair();
      expect(validated).toBe(true);
      // A refused mount leaves the Review exactly as it found it; a committed
      // one adds the two rows the import and the rebuild contribute.
      expect({
        status: response.status,
        rows: documentRows(stored.dir).length,
        treeUnchanged: isDeepStrictEqual(
          await snapshotWithoutArtifacts(stored.dir),
          before,
        ),
      }).toEqual(
        success
          ? { status: 200, rows: 2, treeUnchanged: false }
          : { status: 422, rows: 0, treeUnchanged: true },
      );
      if (!success) return;
      const result = await response.json();
      checkReviewThreadDbVersion(reviewPath);
      // The unconvertible revision keeps a row of its own; the repair row
      // beside it carries the rebuilt bytes and takes the pointer.
      const rows = documentRows(stored.dir);
      expect(rows.map((row) => row.operation)).toEqual(["repair", "publish"]);
      expect(rows[0]?.publicationId).toBe(result.newDocumentRevision);
      expect(presentedDocument(stored.dir)).toBe(result.newDocumentRevision);
      expect(result.sourceFallback).toEqual({ document: true, map: false });
      expect(readLegacyArtifactImport(stored.dir)).toMatchObject({
        versions: 1,
      });
      const prefix = `/sessions/${result.sessionId}/__progressive-review`;
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
    }
  },
);

it("adds exactly one repair row when the stored document bytes are lost", async () => {
  const { stored, server, repair } = await fixture({
    schemaVersion: 6,
    sealedDocument: "json",
    imported: true,
  });
  try {
    const before = documentRows(stored.dir);
    expect(before).toHaveLength(1);
    await rm(path.join(stored.dir, "artifacts"), {
      recursive: true,
      force: true,
    });
    const response = await repair();
    expect(response.status).toBe(200);
    const result = await response.json();
    const after = documentRows(stored.dir);
    expect(after).toHaveLength(2);
    // The publication the repair replaces is untouched, byte for byte.
    expect(after[1]).toEqual(before[0]);
    expect(after[0]?.operation).toBe("repair");
    expect(after[0]?.previousPublicationId).toBe(before[0]?.publicationId);
    expect(after[0]?.publicationId).toBe(result.newDocumentRevision);
    expect(result.oldDocumentRevision).toBe(before[0]?.publicationId);
    expect(presentedDocument(stored.dir)).toBe(result.newDocumentRevision);
    // Repair replaces bytes, never the diff a presentation was published on.
    const previous = parsePublicationRecord(before[0]!.record);
    const repaired = parsePublicationRecord(after[0]!.record);
    expect(repaired.baseCommit).toBe(previous.baseCommit);
    expect(repaired.sourceCommit).toBe(previous.sourceCommit);
  } finally {
    await server.close();
  }
});

it.each([4, 5] as const)(
  "imports a schema-%i history into rows before repairing it",
  async (schemaVersion) => {
    const { stored, server, oldRevision, repair } = await fixture({
      schemaVersion,
      sealedDocument: "json",
    });
    try {
      const response = await repair();
      expect(response.status).toBe(200);
      const result = await response.json();
      // The Git-era publication becomes a row keyed by its own commit, and a
      // healthy JSON document needs no replacement beside it.
      expect(documentRows(stored.dir).map((row) => row.publicationId)).toEqual([
        oldRevision,
      ]);
      expect(result.newDocumentRevision).toBe(oldRevision);
      expect(jsonObject(readReviewRecord(stored.dir))).toMatchObject({
        schemaVersion: 6,
        dismissedAt: "2026-09-01T01:00:00Z",
        viewedAt: "2026-09-01T00:01:00Z",
        status: "accepted",
      });
    } finally {
      await server.close();
    }
  },
);

// The other promotion-time guard — a write to a Review's own legacy thread
// database between prepare and promote — is covered directly in
// `review-repair.test.ts`: mounting a session migrates those threads into the
// shared database, so the desktop flow never carries the isolated upgrade.
it("refuses a repair whose authoring inputs move before promotion", async () => {
  const { stored, server, repair } = await fixture();
  try {
    expect("error" in (await readStoredReview(stored.dir))).toBe(true);
    dispatchVerb = async (_sessionId, value) => {
      if (jsonObject(value)?.name === "validateCanvasMount")
        await writeFile(
          path.join(stored.dir, "data.ts"),
          "export const concurrent = true;\n",
        );
      return { ok: true };
    };
    const presentedBefore = presentedDocument(stored.dir);
    const response = await repair();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(documentRows(stored.dir)).toEqual([]);
    expect(presentedDocument(stored.dir)).toBe(presentedBefore);
  } finally {
    await server.close();
  }
});

it("switches repaired comments to live snapshots for resynchronization after promotion", async () => {
  const { stored, record, oldRevision, server, post, get, repair } =
    await fixture({
      schemaVersion: 6,
      sealedDocument: "json",
      imported: true,
    });
  await rm(path.join(stored.dir, "artifacts"), {
    recursive: true,
    force: true,
  });
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
    return { ok: true };
  };
  try {
    const repaired = await repair();
    expect(repaired.status).toBe(200);
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
      revision: oldRevision,
    });
    expect(historical.status).toBe(201);
    const historicalPrefix = `/sessions/${(await historical.json()).sessionId}/__progressive-review`;
    const historicalSnapshot = ReviewThreadsSnapshotResponseSchema.parse(
      await (await get(`${historicalPrefix}/comments`)).json(),
    );
    if (!historicalSnapshot.ok) throw new Error(historicalSnapshot.error);
    expect(historicalSnapshot.snapshot.revision).toBe(0);
    expect(
      (await post(`${historicalPrefix}/thread-commands`, comment(4))).status,
    ).toBe(409);
  } finally {
    await server.close();
  }
});

it.each([true, false])(
  "replaces only the repaired current-schema session when mount succeeds: %s",
  async (mountSucceeds) => {
    const { stored, record, server, post, list, get, repair } = await fixture({
      schemaVersion: 6,
      sealedDocument: "json",
      imported: true,
    });
    dispatchVerb = async (_sessionId, value) =>
      jsonObject(value)?.name === "validateCanvasMount" && !mountSucceeds
        ? { ok: false, error: "test mount failure" }
        : { ok: true };
    try {
      // Dropping the stored bytes leaves a row whose document needs
      // republishing until repair rebuilds it.
      await rm(path.join(stored.dir, "artifacts"), {
        recursive: true,
        force: true,
      });
      const before = documentRows(stored.dir);
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
      const response = await repair();
      const result = await response.json();
      expect(response.status).toBe(mountSucceeds ? 200 : 422);
      expect(
        (await list()).items.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual([mountSucceeds ? result.sessionId : old.sessionId]);
      expect(documentRows(stored.dir)).toHaveLength(mountSucceeds ? 2 : 1);
      expect(presentedDocument(stored.dir)).toBe(
        mountSucceeds ? result.newDocumentRevision : before[0]?.publicationId,
      );
    } finally {
      await server.close();
    }
  },
);

it.each(["success", "mount-failure"] as const)(
  "repair server preserves lifecycle and visible session on %s",
  async (outcome) => {
    const { stored, record, server, post, list, visible, get, repair } =
      await fixture();
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
      const recordBefore = await readFile(
        path.join(stored.dir, "review.json"),
        "utf8",
      );
      const fingerprintBefore = await fingerprintReviewRepairInputs(stored.dir);
      const response = await repair();
      const result = await response.json();
      const success = outcome === "success";
      expect(validationReads).toEqual([{ status: 200, record: recordBefore }]);
      expect(response.status).toBe(success ? 200 : 422);
      expect(result).toMatchObject(
        success ? { ok: true, status: "accepted", noop: false } : { ok: false },
      );
      expect(jsonObject(readReviewRecord(stored.dir))).toMatchObject(
        success
          ? {
              schemaVersion: 6,
              status: "accepted",
              presentedDocumentRevision: result.newDocumentRevision,
            }
          : { status: "accepted", schemaVersion: 4 },
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
      // A committed repair refreshes the record mirror; a refused one leaves
      // every fingerprinted input exactly as it found it.
      expect(
        (await fingerprintReviewRepairInputs(stored.dir)) === fingerprintBefore,
      ).toBe(!success);
    } finally {
      await server.close();
    }
  },
);
