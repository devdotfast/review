import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../base/common/uri.js";
import { FilePermission, FileSystemProviderCapabilities, FileType } from "../../platform/files/common/files.js";
import { HostQueryBodySchema, type ReviewHostSourceTarget } from "../common/reviewProtocol.js";
import { ReviewHostSourceService, hostSourceUri, parseHostSourceUri, hostSourceDiffMappings } from "./reviewHostSourceService.js";
import type { ReviewCodeDiffTarget } from "./reviewCodeResourceService.js";

const hostId = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const workspaceId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const otherId = "381427b2-36bc-4d40-a043-915860ca46d0";
const target: ReviewHostSourceTarget = { reviewId: hostId, reviewVersion: 4, range: { side: "head", file: "src/space name.ts", fromLine: 2, toLine: 3 } };
const request = { reviewId: target.reviewId, reviewVersion: target.reviewVersion, side: target.range.side, file: target.range.file };

test("source URI preserves immutable identity and rejects missing or invalid coordinates", () => {
  const resource = hostSourceUri(hostId, workspaceId, request);
  assert.deepEqual(parseHostSourceUri(URI.parse(resource.toString())), { hostId, workspaceId, request });
  assert.notEqual(resource.toString(), hostSourceUri(hostId, workspaceId, { ...request, reviewVersion: 5 }).toString());
  const scoped = hostSourceUri(hostId, workspaceId, { ...request, comparisonCommit: "a".repeat(40) });
  assert.equal(parseHostSourceUri(scoped).request.comparisonCommit, "a".repeat(40));
  assert.notEqual(scoped.toString(), resource.toString());
  const query = new URLSearchParams(resource.query);
  query.delete("reviewVersion");
  assert.throws(() => parseHostSourceUri(resource.with({ query: query.toString() })), /version is missing/);
  assert.throws(() => hostSourceUri(hostId, workspaceId, { ...request, file: "../secret" }), /relative|path|Invalid/i);
  assert.throws(() => parseHostSourceUri(URI.file("/tmp/source.ts")), /not a Review source/);
});

test("native source reads only authenticated pinned API bytes and opens the selected readonly file", async (t) => {
  const calls: ReturnType<typeof HostQueryBodySchema.parse>[] = [];
  const text = "first\r\nsecond\r\nthird\r\n";
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("x-review-token"), "secret");
    const url = new URL(input);
    assert.equal(url.searchParams.has("token"), false);
    if (url.pathname === "/v1/connection") return Response.json({ ok: true, data: { apiVersion: 1, hostId, workspaceId, principal: { id: hostId, kind: "human", displayName: "You" } } });
    assert.equal(url.pathname, `/v1/workspaces/${workspaceId}/queries`);
    const query = HostQueryBodySchema.parse(JSON.parse(String(init?.body)));
    calls.push(query);
    if (query.type === "source.tree") return Response.json({ ok: true, data: { result: { items: [{ path: request.file, kind: "file", objectId: "b".repeat(40), byteLength: text.length }], nextCursor: null }, eventCursor: "cursor-one" } });
    assert.equal(query.type, "source.read");
    return Response.json({ ok: true, data: { result: { repositoryId: hostId, commit: "a".repeat(40), blob: "b".repeat(40), file: request.file, range: null, text, sha256: "c".repeat(64) }, eventCursor: "cursor-one" } });
  });
  const opened: { resource: URI; options: { pinned: boolean; selection: { startLineNumber: number; endLineNumber: number } } }[] = [];
  const models: URI[] = [];
  let disposed = 0;
  const service = new ReviewHostSourceService(
    { getConnection: async () => ({ serverUrl: "http://127.0.0.1:5570", token: "secret" }) } as never,
    { registerProvider: () => ({ dispose() {} }) } as never,
    { createModelReference: async (uri: URI) => { models.push(uri); return { object: { textEditorModel: { getLineCount: () => 3 } }, dispose: () => disposed++ }; } } as never,
    { openEditor: async (input: typeof opened[number]) => { opened.push(input); } } as never,
  );
  t.after(() => service.dispose());
  const resource = hostSourceUri(hostId, workspaceId, request);
  assert.equal(new TextDecoder().decode(await service.readFile(resource)), text);
  assert.deepEqual(calls[0].input, request);
  assert.equal((await service.stat(resource)).permissions, FilePermission.Readonly);
  assert.ok(service.capabilities & FileSystemProviderCapabilities.Readonly);
  await assert.rejects(service.readFile(hostSourceUri(otherId, workspaceId, request)), /another host/);
  await assert.rejects(service.writeFile(), /read-only/);
  await assert.rejects(service.delete(), /read-only/);
  await service.openSource(target);
  assert.equal(opened[0].resource.toString(), resource.toString());
  assert.equal(opened[0].options.pinned, true);
  assert.equal(opened[0].options.selection.startLineNumber, 2);
  assert.equal(opened[0].options.selection.endLineNumber, 3);
  const snippet = await service.acquireSnippet(target);
  assert.equal(models[0].toString(), resource.toString());
  assert.equal(snippet.target.workingTreeFallback, false);
  snippet.dispose();
  assert.equal(disposed, 1);
  await assert.rejects(service.acquireSnippet({ ...target, range: { ...target.range, toLine: 4 } }), /retained source range is unavailable/);
  assert.equal(disposed, 2);
  const requested: ReviewHostSourceTarget[] = [];
  await service.requestComment(resource, { fromLine: 2, toLine: 3 });
  const wrongVersion: ReviewHostSourceTarget[] = [];
  const otherVersionSubscription = service.subscribeComments(target.reviewId, selected => wrongVersion.push(selected), () => 5);
  const subscription = service.subscribeComments(target.reviewId, selected => requested.push(selected), () => 4);
  assert.deepEqual(requested, [target]);
  assert.deepEqual(wrongVersion, []);
  await service.requestComment(resource, { fromLine: 1, toLine: 1 });
  assert.equal(requested[1].reviewVersion, 4);
  assert.deepEqual(requested[1].range, { ...target.range, fromLine: 1, toLine: 1 });
  assert.deepEqual(wrongVersion, []);
  subscription.dispose();
  otherVersionSubscription.dispose();
});

test("native diff loads every API page at one version and represents added/deleted sides as absent", async (t) => {
  let version = 4;
  const calls: ReturnType<typeof HostQueryBodySchema.parse>[] = [];
  const commit = "d".repeat(40);
  t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ ok: true, data: { apiVersion: 1, hostId, workspaceId, principal: { id: hostId, kind: "human", displayName: "You" } } });
    const query = HostQueryBodySchema.parse(JSON.parse(String(init.body)));
    calls.push(query);
    assert.equal(query.type, "source.diff");
    if (query.type !== "source.diff") throw new Error("Unexpected source query");
    version = 5;
    return Response.json({ ok: true, data: { result: query.input.cursor ? {
      items: [{ path: "removed.ts", status: "deleted", additions: 0, deletions: 2, binary: false }], nextCursor: null,
    } : {
      items: [{ path: "new.ts", status: "added", additions: 3, deletions: 0, binary: false }, { path: "renamed.ts", previousPath: "old.ts", status: "renamed", additions: 1, deletions: 1, binary: false }], nextCursor: "next-page",
    }, eventCursor: "cursor-one" } });
  });
  const service = new ReviewHostSourceService(
    { getConnection: async () => ({ serverUrl: "http://127.0.0.1:5570", token: "secret" }) } as never,
    { registerProvider: () => ({ dispose() {} }) } as never,
    {} as never, {} as never,
  );
  t.after(() => service.dispose());
  const source = service.createCanvasSource(hostId, () => version, {} as never);
  const data = await source.diffViewSource.load({ commit });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.type === "source.diff" && call.input.reviewVersion === 4 && call.input.comparisonCommit === commit));
  assert.equal(new URLSearchParams(data.sourceUri.query).get("reviewVersion"), "4");
  assert.equal(data.entries[0].original, undefined);
  assert.equal(parseHostSourceUri(data.entries[0].modified!).request.file, "new.ts");
  assert.equal(parseHostSourceUri(data.entries[1].original!).request.file, "old.ts");
  assert.equal(parseHostSourceUri(data.entries[1].modified!).request.comparisonCommit, commit);
  assert.equal(data.entries[2].modified, undefined);
  assert.equal(data.entries[2].goToFileResource.toString(), data.entries[2].original!.toString());
  const selections: ReviewHostSourceTarget[] = [];
  service.subscribeComments(hostId, target => selections.push(target));
  await service.requestComment(data.entries[1].original!, { fromLine: 1, toLine: 2 });
  assert.deepEqual(selections, [{ reviewId: hostId, reviewVersion: 4, comparisonCommit: commit, range: { file: "old.ts", side: "base", fromLine: 1, toLine: 2 } }]);
});

test("the existing native file explorer resolves directories through the pinned source tree API", async (t) => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ ok: true, data: { apiVersion: 1, hostId, workspaceId, principal: { id: hostId, kind: "human", displayName: "You" } } });
    const query = HostQueryBodySchema.parse(JSON.parse(String(init.body)));
    assert.equal(query.type, "source.tree");
    if (query.type !== "source.tree") throw new Error("Unexpected source query");
    requests.push(query.input);
    return Response.json({ ok: true, data: { result: { items: query.input.directory ?
      [{ path: "src/index.ts", kind: "file", objectId: "a".repeat(40), byteLength: 18 }] :
      [{ path: "src", kind: "directory", objectId: "b".repeat(40) }], nextCursor: null }, eventCursor: "cursor" } });
  });
  const service = new ReviewHostSourceService(
    { getConnection: async () => ({ serverUrl: "http://127.0.0.1:5570", token: "secret" }) } as never,
    { registerProvider: () => ({ dispose() {} }) } as never,
    {} as never, {} as never,
  );
  t.after(() => service.dispose());
  const root = await service.sourceRoot(hostId, 4);
  assert.equal((await service.stat(root)).type, FileType.Directory);
  assert.deepEqual(await service.readdir(root), [["src", FileType.Directory]]);
  assert.deepEqual(await service.readdir(root.with({ path: "/src" })), [["index.ts", FileType.File]]);
  const stat = await service.stat(root.with({ path: "/src/index.ts" }));
  assert.equal(stat.size, 18);
  assert.equal(stat.permissions, FilePermission.Readonly);
  assert.ok(requests.every(request => (request as { reviewVersion: number }).reviewVersion === 4));
  await assert.rejects(service.stat(root.with({ path: "/src/missing.ts" })), /does not exist/);
});

test("native inline diffs preserve selected windows and release both immutable source models", async (t) => {
  const code = { base: ["before", "old call", "after"], head: ["before", "new call", "after"] };
  t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ ok: true, data: { apiVersion: 1, hostId, workspaceId, principal: { id: hostId, kind: "human", displayName: "You" } } });
    const query = HostQueryBodySchema.parse(JSON.parse(String(init.body)));
    assert.equal(query.type, "source.diff");
    return Response.json({ ok: true, data: { result: { items: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1, binary: false }], nextCursor: null }, eventCursor: "cursor" } });
  });
  const models: URI[] = [];
  let releases = 0;
  const service = new ReviewHostSourceService(
    { getConnection: async () => ({ serverUrl: "http://127.0.0.1:5570", token: "secret" }) } as never,
    { registerProvider: () => ({ dispose() {} }) } as never,
    { createModelReference: async (resource: URI) => { models.push(resource); return { object: { textEditorModel: { getLinesContent: () => code[parseHostSourceUri(resource).request.side] } }, dispose: () => releases++ }; } } as never,
    {} as never,
  );
  t.after(() => service.dispose());
  let loadDiff: (() => Promise<ReviewCodeDiffTarget | undefined>) | undefined;
  const native = { create: (_spec: unknown, _loadModel: unknown, diff: typeof loadDiff) => { loadDiff = diff; return {}; } };
  const source = service.createCanvasSource(hostId, () => 4, native as never);
  source.inlineEditors.create({ path: "file.ts", side: "head", ranges: [{ startLine: 2, endLine: 2 }] } as never);
  const diff = await loadDiff!();
  assert.ok(diff);
  assert.deepEqual(diff.mappings, [{ originalStartLine: 2, originalEndLineExclusive: 3, modifiedStartLine: 2, modifiedEndLineExclusive: 3 }]);
  assert.equal(diff.windows(3, 3).modified[0].startLine, 1);
  assert.equal(releases, 2);
  assert.ok(models.every(resource => parseHostSourceUri(resource).request.reviewVersion === 4));
  assert.deepEqual(hostSourceDiffMappings(["same"], ["same"]), []);
});

test("an empty diff model is allowed only for an API-confirmed absent side and cannot receive comments", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ ok: true, data: { apiVersion: 1, hostId, workspaceId, principal: { id: hostId, kind: "human", displayName: "You" } } });
    const query = HostQueryBodySchema.parse(JSON.parse(String(init.body)));
    assert.equal(query.type, "source.diff");
    return Response.json({ ok: true, data: { result: { items: [{ path: "new.ts", status: "added", additions: 1, deletions: 0, binary: false }], nextCursor: null }, eventCursor: "cursor" } });
  });
  const service = new ReviewHostSourceService(
    { getConnection: async () => ({ serverUrl: "http://127.0.0.1:5570", token: "secret" }) } as never,
    { registerProvider: () => ({ dispose() {} }) } as never, {} as never, {} as never,
  );
  t.after(() => service.dispose());
  const original = hostSourceUri(hostId, workspaceId, { ...request, file: "new.ts", side: "base" });
  const empty = original.with({ query: `${original.query}&diffAbsent=1` });
  assert.equal((await service.readFile(empty)).byteLength, 0);
  await assert.rejects(service.requestComment(empty, { fromLine: 1, toLine: 1 }), /has no source/);
  const existing = hostSourceUri(hostId, workspaceId, { ...request, file: "new.ts", side: "head" });
  await assert.rejects(service.readFile(existing.with({ query: `${existing.query}&diffAbsent=1` })), /not absent/);
});
