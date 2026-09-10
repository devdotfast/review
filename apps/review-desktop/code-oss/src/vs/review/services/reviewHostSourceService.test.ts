import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../base/common/uri.js";
import { FilePermission, FileSystemProviderCapabilities } from "../../platform/files/common/files.js";
import { HostQuerySchema, type ReviewHostSourceTarget } from "../common/reviewProtocol.js";
import { ReviewHostSourceService, hostSourceUri, parseHostSourceUri } from "./reviewHostSourceService.js";

const hostId = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const workspaceId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const otherId = "381427b2-36bc-4d40-a043-915860ca46d0";
const target: ReviewHostSourceTarget = { reviewId: hostId, documentVersion: 4, range: { side: "head", file: "src/space name.ts", fromLine: 2, toLine: 3 } };
const request = { reviewId: target.reviewId, documentVersion: target.documentVersion, side: target.range.side, file: target.range.file };

test("source URI preserves immutable identity and rejects missing or invalid coordinates", () => {
  const resource = hostSourceUri(hostId, workspaceId, request);
  assert.deepEqual(parseHostSourceUri(URI.parse(resource.toString())), { hostId, workspaceId, request });
  assert.notEqual(resource.toString(), hostSourceUri(hostId, workspaceId, { ...request, documentVersion: 5 }).toString());
  const query = new URLSearchParams(resource.query);
  query.delete("documentVersion");
  assert.throws(() => parseHostSourceUri(resource.with({ query: query.toString() })), /version is missing/);
  assert.throws(() => hostSourceUri(hostId, workspaceId, { ...request, file: "../secret" }), /relative|path|Invalid/i);
  assert.throws(() => parseHostSourceUri(URI.file("/tmp/source.ts")), /not a Review source/);
});

test("native source reads only authenticated pinned API bytes and opens the selected readonly file", async (t) => {
  const calls: ReturnType<typeof HostQuerySchema.parse>[] = [];
  const text = "first\r\nsecond\r\nthird\r\n";
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("x-review-token"), "secret");
    const url = new URL(input);
    assert.equal(url.searchParams.has("token"), false);
    if (url.pathname === "/v1/connection") return Response.json({ apiVersion: 1, hostId, workspaceId, principal: { id: hostId, kind: "human", displayName: "You" } });
    const query = HostQuerySchema.parse(JSON.parse(String(init?.body)));
    calls.push(query);
    assert.equal(query.type, "source.file");
    return Response.json({ ok: true, data: { result: { repositoryId: hostId, commit: "a".repeat(40), blob: "b".repeat(40), file: request.file, text, sha256: "c".repeat(64) }, eventCursor: "cursor-one" } });
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
  assert.equal(calls[0].hostId, hostId);
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
  const subscription = service.subscribeComments(target.reviewId, selected => requested.push(selected));
  assert.deepEqual(requested, [target]);
  await service.requestComment(resource, { fromLine: 1, toLine: 1 });
  assert.equal(requested[1].documentVersion, 4);
  assert.deepEqual(requested[1].range, { ...target.range, fromLine: 1, toLine: 1 });
  subscription.dispose();
});
