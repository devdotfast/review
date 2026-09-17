import { sourceTreeUri, sourceTreeRoot } from "../common/reviewSourceView.js";
import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../base/common/uri.js";
import type { ITextModelContentProvider } from "../../editor/common/services/resolverService.js";
import { apiSourceUri, ReviewApiSourceService } from "./reviewApiSourceService.js";
import type { ReviewDiffViewSource } from "./reviewDiffViewService.js";
import { resolveReviewSourceView, reviewSourceComparison } from "../common/reviewProtocol.js";
import type { ReviewInlineSource } from "./reviewInlineEditorService.js";

const view = (version: number) => resolveReviewSourceView({ reviewId: "review-a", version, pins: {} });

function setup() {
	let provider: ITextModelContentProvider;
	let disposed = 0;
	const models = new Map<string, { uri: URI; text: string; getLineCount(): number }>();
	const opened: Array<{ original: { resource: URI }; modified: { resource: URI } }> = [];
	const editor = { resource: URI.parse("review-api-source://review-a/file") };
	const registered: string[] = [];
	const service = new ReviewApiSourceService(
		{
			getConnection: async () => ({ serverUrl: "http://localhost:5570", token: "secret" }),
		} as never,
		{
			registerTextModelContentProvider: (scheme: string, value: ITextModelContentProvider) => {
				if (scheme === "review-api-source") provider = value;
				return { dispose() { } };
			},
			createModelReference: async (uri: URI) => ({
				object: { textEditorModel: await provider.provideTextContent(uri) },
				dispose: () => disposed++,
			}),
		} as never,
		{
			getModel: (uri: URI) => models.get(uri.toString()),
			createModel: (text: string, _: unknown, uri: URI) => {
				const model = { uri, text, getLineCount: () => text.split("\n").length };
				models.set(uri.toString(), model);
				return model;
			},
		} as never,
		{ createByFilepathOrFirstLine: () => ({ languageId: "typescript" }) } as never,
		{
			openEditor: async (input: (typeof opened)[number]) => {
				opened.push(input);
				return { input: editor };
			},
		} as never,
		{
			registerReviewEditor(reviewId: string) {
				registered.push(reviewId);
			},
		} as never,
		{} as never,
	);
	return {
		service,
		models,
		opened,
		registered,
		disposed: () => disposed,
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
		() => view(version),
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
	assert.equal(models.get(snippet.target.resource.toString())?.text, "old first line\nold second line");
	snippet.dispose();
	assert.equal(disposed(), 1);
	assert.notEqual(
		apiSourceUri({
			view: view(3),
			file: "src/[route].ts",
			side: "base",
		}).toString(),
		apiSourceUri({
			view: view(4),
			file: "src/[route].ts",
			side: "base",
		}).toString(),
	);
});

test("diff entries keep rename paths and missing sides, even when the review advances during the read", async (t) => {
	const { service } = setup();
	t.after(() => service.dispose());
	let version = 7;
	let generation = "a".repeat(64);
	t.mock.method(globalThis, "fetch", async (value: string) => {
		const url = new URL(value);
		assert.equal(url.searchParams.get("version"), "7");
		assert.equal(url.searchParams.get("commit"), "selected-commit");
		version = 8;
		generation = "b".repeat(64);
		return Response.json([
			{ path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 0, deletions: 0 },
			{ path: "added.ts", status: "added", additions: 1, deletions: 0 },
			{ path: "removed.ts", status: "deleted", additions: 0, deletions: 1 },
		]);
	});
	let source!: ReviewDiffViewSource;
	const canvas = service.canvas(
		() => resolveReviewSourceView({ reviewId: "review-a", version, pins: { worktreeRevision: generation } }),
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
	assert.equal(result.entries.find(entry => entry.file.path === "new.ts")!.original!.path, "/old.ts");
	assert.equal(result.entries.find(entry => entry.file.path === "new.ts")!.modified!.path, "/new.ts");
	assert.equal(result.entries.find(entry => entry.file.path === "added.ts")!.original, undefined);
	assert.equal(result.entries.find(entry => entry.file.path === "removed.ts")!.modified, undefined);
	for (const entry of result.entries) {
		assert.equal(new URLSearchParams(entry.goToFileResource.query).get("version"), "7");
		assert.equal(new URLSearchParams(entry.goToFileResource.query).get("commit"), "selected-commit");
		assert.equal(entry.goToFileResource.scheme, "review-api-source");
		assert.equal(new URLSearchParams(entry.goToFileResource.query).get("generation"), "a".repeat(64));
		assert.equal(new URLSearchParams(entry.goToFileResource.query).has("live"), false);
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
		() => view(0),
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
		return Response.json([
			{ path: "src/[route].ts", kind: "file" },
			{ path: "src/lib", kind: "directory" },
		]);
	});
	const root = apiSourceUri({ view: reviewSourceComparison(view(3), "chosen-commit"), side: "base", file: "src" });
	const [file, folder] = await service.children(root);
	assert.equal(file!.resource.path, "/src/[route].ts");
	assert.equal(file!.resource.query, root.query);
	assert.equal(file!.readonly, true);
	assert.equal(folder!.isDirectory, true);
});

test("opening a native diff preserves renames and empty sides at the selected version", async (t) => {
	const { service, opened, registered } = setup();
	t.after(() => service.dispose());
	t.mock.method(globalThis, "fetch", async (value: string) => {
		assert.equal(new URL(value).searchParams.get("version"), "3");
		return Response.json([
			{ path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 0, deletions: 0 },
			{ path: "added.ts", status: "added", additions: 1, deletions: 0 },
			{ path: "removed.ts", status: "deleted", additions: 0, deletions: 1 },
		]);
	});
	for (const file of ["new.ts", "added.ts", "removed.ts"]) await service.openDiff(view(3), file);
	assert.equal(opened[0]!.original.resource.path, "/old.ts");
	assert.equal(opened[0]!.modified.resource.path, "/new.ts");
	assert.equal(new URLSearchParams(opened[1]!.original.resource.query).get("empty"), "true");
	assert.equal(new URLSearchParams(opened[2]!.modified.resource.query).get("empty"), "true");
	assert.deepEqual(registered, ["review-a", "review-a", "review-a"]);
	for (const entry of opened)
		for (const side of [entry.original, entry.modified]) {
			assert.equal(side.resource.scheme, "review-api-source");
			assert.equal(new URLSearchParams(side.resource.query).get("version"), "3");
		}
	await assert.rejects(service.openDiff(view(3), "unchanged.ts"), /not changed/);
	assert.equal(opened.length, 3);
});


test("a refreshed current tree keeps its root when a file from the newer version opens", async t => {
  const { service } = setup();
  t.after(() => service.dispose());
  let version = 3;
  const root = sourceTreeUri({ reviewId: "review-a", kind: "current" });
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    if (url.pathname.endsWith("/tree")) {
      assert.equal(url.searchParams.get("version"), String(version));
      return Response.json([{ path: "src", kind: "directory" }, { path: "file.ts", kind: "file" }]);
    }
    assert.equal(url.searchParams.has("version"), false);
    return Response.json({ reviewId: "review-a", version, pins: { worktreeRevision: String(version).repeat(64) } });
  });
  const first = await service.children(root);
  version = 4;
  const refreshed = await service.children(root);
  assert.equal(first[0]!.resource.toString(), refreshed[0]!.resource.toString());
  assert.notEqual(first[1]!.resource.toString(), refreshed[1]!.resource.toString());
  assert.equal(new URLSearchParams(refreshed[1]!.resource.query).get("version"), "4");
  assert.equal(sourceTreeRoot(refreshed[1]!.resource, root).toString(), root.toString());
  const fixed = sourceTreeUri({ reviewId: "review-a", kind: "version", version: 3 });
  assert.notEqual(sourceTreeRoot(refreshed[1]!.resource, fixed).toString(), fixed.toString());
});
