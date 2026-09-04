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
async function fixture() {
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
    schemaVersion: 4,
    status: "accepted",
    lastPublishedAt: "2026-09-01T00:00:00Z",
    dismissedAt: "2026-09-01T01:00:00Z",
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
  return { stored, record, request, server, post, list };
}
it.each([
  "success",
  "mount-failure",
  "concurrent-edit",
  "changed-pins",
  "staging-link",
] as const)(
  "repair server preserves lifecycle and visible session on %s",
  async (outcome) => {
    const { stored, record, request, server, post, list } = await fixture();
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
    vi.spyOn(
      GlobalReviewDesktopVerbRelay.prototype,
      "dispatch",
    ).mockImplementation(async (_id, value) => {
      if (jsonObject(value)?.name === "validateCanvasMount") {
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
      const opened = await post(`/reviews/${record.uuid}/open`, {});
      expect(opened.status).toBe(201);
      const old = await opened.json();
      const response = await post("/repair-ready", request);
      const result = await response.json();
      const success = outcome === "success";
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
      ).toEqual([success ? result.sessionId : old.sessionId]);
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
