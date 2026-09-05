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
import { fileURLToPath } from "node:url";

import { jsonObject } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { createReviewDir } from "../review-home";
import {
  type ReviewRepairReadyRequest,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import { closeAllReviewThreadStores } from "../review-thread-store-backend";
import { reviewVcs } from "../review-vcs";
import { createGlobalReviewServer } from "./desktop-server";
import { GlobalReviewDesktopVerbRelay } from "./global-verb-relay";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
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
  });
  await server.listen();
  const post = (
    route: string,
    body: ReviewRepairReadyRequest | Record<string, never>,
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
it.each([true, false])(
  "replaces only the repaired current-schema session when mount succeeds: %s",
  async (mountSucceeds) => {
    const { stored, record, request, server, post, list, get } =
      await fixture(5);
    vi.spyOn(
      GlobalReviewDesktopVerbRelay.prototype,
      "dispatch",
    ).mockImplementation(async (_sessionId, value) =>
      jsonObject(value)?.name === "validateCanvasMount" && !mountSucceeds
        ? { ok: false, error: "test mount failure" }
        : { ok: true },
    );
    try {
      const opened = await post(`/reviews/${record.uuid}/open`, {});
      expect(opened.status).toBe(201);
      const old = await opened.json();
      const document = await get(
        `/sessions/${old.sessionId}/__progressive-review/document`,
      );
      expect(document.status).toBe(409);
      expect(await document.json()).toMatchObject({ code: "needs_republish" });
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
    vi.spyOn(
      GlobalReviewDesktopVerbRelay.prototype,
      "dispatch",
    ).mockImplementation(async (sessionId, value) => {
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
    });
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
