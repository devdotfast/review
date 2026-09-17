import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../base/common/uri.js";
import type { ITextModelContentProvider } from "../../editor/common/services/resolverService.js";
import type { ReviewInlineSource } from "./reviewInlineEditorService.js";
import type { ReviewDiffViewSource } from "./reviewDiffViewService.js";
import { apiSourceUri, ReviewApiSourceService } from "./reviewApiSourceService.js";

function setup() {
  let provider: ITextModelContentProvider;
  let disposed = 0;
  const models = new Map<string, { uri: URI; text: string; getLineCount(): number }>();
  const service = new ReviewApiSourceService(
    {
      getConnection: async () => ({ serverUrl: "http://localhost:5570", token: "secret" }),
    } as never,
    {
      registerTextModelContentProvider: (_: string, value: ITextModelContentProvider) => {
        provider = value;
        return { dispose() {} };
      },
      createModelReference: async (uri: URI) => ({
        object: { textEditorModel: await provider.provideTextContent(uri) },
        dispose: () => disposed++,
      }),
    } as never,
    {
      onModelAdded: () => ({ dispose() {} }),
      onModelRemoved: () => ({ dispose() {} }),
      getModel: (uri: URI) => models.get(uri.toString()),
      createModel: (text: string, _: unknown, uri: URI) => {
        const model = { uri, text, getLineCount: () => text.split("\n").length };
        models.set(uri.toString(), model);
        return model;
      },
    } as never,
    { createByFilepathOrFirstLine: () => ({ languageId: "typescript" }) } as never,
    {} as never,
    { registerReviewEditor() {} } as never,
    { definitionProvider: { register: () => ({ dispose() {} }) }, hoverProvider: { register: () => ({ dispose() {} }) }, referenceProvider: { register: () => ({ dispose() {} }) } } as never,
    {} as never, {} as never, {} as never,
  );
  return {
    service, models, disposed: () => disposed,
  };
}

test("a native peek reads the pinned version through the authenticated API, not a working file", async (t) => {
  const { service, models, disposed } = setup();
  t.after(() => service.dispose());
  t.mock.method(globalThis, "fetch", async (value: string, init: RequestInit) => {
    const url = new URL(value);
    assert.equal(new Headers(init.headers).get("x-review-token"), "secret");
    assert.equal(url.searchParams.get("version"), "3");
    assert.equal(url.pathname, "/reviews-api/review-a/file");
    assert.equal(url.searchParams.get("side"), "base");
    assert.equal(url.searchParams.get("file"), "src/[route].ts");
    return Response.json({ text: "old first line\nold second line" });
  });
  let version = 3;
  let source!: ReviewInlineSource;
  const canvas = service.canvas(
    "review-a",
    () => version,
    {
      create: (_: unknown, input: ReviewInlineSource) => {
        source = input;
        return {};
      },
    } as never,
    {} as never,
  );
  canvas.inlineEditors.create({
    path: "src/[route].ts",
    side: "base",
    ranges: [{ startLine: 2, endLine: 2 }],
  } as never);
  version = 4;
  const snippet = await source.snippet();
  assert.equal(
    models.get(snippet.target.resource.toString())?.text,
    "old first line\nold second line",
  );
  assert.equal(snippet.target.workingTreeFallback, false);
  snippet.dispose();
  assert.equal(disposed(), 1);
  assert.notEqual(
    apiSourceUri({
      reviewId: "review-a",
      version: 3,
      file: "src/[route].ts",
      side: "base",
    }).toString(),
    apiSourceUri({
      reviewId: "review-a",
      version: 4,
      file: "src/[route].ts",
      side: "base",
    }).toString(),
  );
});

test("diff entries keep rename paths and missing sides, even when the review advances during the read", async (t) => {
  const { service } = setup();
  t.after(() => service.dispose());
  let version = 7;
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    assert.equal(url.searchParams.get("version"), "7");
    assert.equal(url.searchParams.get("commit"), "selected-commit");
    version = 8;
    return Response.json([
      { path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 0, deletions: 0 },
      { path: "added.ts", status: "added", additions: 1, deletions: 0 },
      { path: "removed.ts", status: "deleted", additions: 0, deletions: 1 },
    ]);
  });
  let source!: ReviewDiffViewSource;
  const canvas = service.canvas(
    "review-a",
    () => version,
    {} as never,
    {
      create: (_: unknown, input: ReviewDiffViewSource) => {
        source = input;
        return {};
      },
    } as never,
  );
  canvas.diffView.create({} as never);
  const result = await source.load({ commit: "selected-commit" });
  assert.equal(result.entries[0]!.original!.path, "/old.ts");
  assert.equal(result.entries[0]!.modified!.path, "/new.ts");
  assert.equal(result.entries[1]!.original, undefined);
  assert.equal(result.entries[2]!.modified, undefined);
  for (const entry of result.entries) {
    assert.equal(new URLSearchParams(entry.goToFileResource.query).get("version"), "7");
    assert.equal(
      new URLSearchParams(entry.goToFileResource.query).get("commit"),
      "selected-commit",
    );
    assert.equal(entry.goToFileResource.scheme, "review-api-source");
  }
});

test("unavailable pinned files report the API error instead of falling back to disk", async (t) => {
  const { service, disposed } = setup();
  t.after(() => service.dispose());
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "File is unavailable at the pinned commit." }, { status: 404 }),
  );
  let source!: ReviewInlineSource;
  const canvas = service.canvas(
    "review-a",
    () => 0,
    {
      create: (_: unknown, input: ReviewInlineSource) => {
        source = input;
        return {};
      },
    } as never,
    {} as never,
  );
  canvas.inlineEditors.create({
    path: "missing.ts",
    side: "head",
    ranges: [{ startLine: 1, endLine: 1 }],
  } as never);
  await assert.rejects(source.snippet(), /unavailable at the pinned commit/);
  assert.equal(disposed(), 0);
});

test("tree entries retain version, side and selected commit when opening a child", async (t) => {
  const { service } = setup();
  t.after(() => service.dispose());
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    assert.equal(url.pathname, "/reviews-api/review-a/tree");
    assert.equal(url.searchParams.get("path"), "src");
    assert.equal(url.searchParams.get("version"), "3");
    assert.equal(url.searchParams.get("side"), "base");
    assert.equal(url.searchParams.get("commit"), "chosen-commit");
    return Response.json([{ path: "src/[route].ts", kind: "file" }, { path: "src/lib", kind: "directory" }]);
  });
  const root = apiSourceUri({ reviewId: "review-a", version: 3, side: "base", file: "src", commit: "chosen-commit" });
  const [file, folder] = await service.children(root);
  assert.equal(file!.resource.path, "/src/[route].ts");
  assert.equal(file!.resource.query, root.query);
  assert.equal(file!.readonly, true);
  assert.equal(folder!.isDirectory, true);
});
