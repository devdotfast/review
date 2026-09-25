import { sourceLocation, sourceTreeUri, sourceTreeRoot } from "../common/reviewSourceView.js";
import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../base/common/uri.js";
import type { ITextModelContentProvider } from "../../editor/common/services/resolverService.js";
import { apiSourceUri, ReviewApiSourceService } from "./reviewApiSourceService.js";
import type { ReviewDiffViewSource } from "./reviewDiffViewService.js";
import { resolveReviewSourceView, reviewSourceAnchor, reviewSourceComparison } from "../common/reviewProtocol.js";
import type { ReviewDiffLens } from "../common/reviewProtocol.js";

const view = (version: number) => resolveReviewSourceView({ reviewId: "review-a", version, pins: {} });

function setup() {
	let provider: ITextModelContentProvider;
	let disposed = 0;
	const models = new Map<string, { uri: URI; text: string; language: unknown; getLineCount(): number }>();
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
			createModel: (text: string, language: unknown, uri: URI) => {
				const model = { uri, text, language, getLineCount: () => text.split("\n").length };
				models.set(uri.toString(), model);
				return model;
			},
		} as never,
		{ createById: (languageId: string) => ({ languageId }), createByFilepathOrFirstLine: () => ({ languageId: "typescript" }) } as never,
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
		readModel: (uri: URI) => provider.provideTextContent(uri),
	};
}

test("a document diff retains its pinned comparison even if the review advances before loading", async (t) => {
	const { service, readModel } = setup();
	t.after(() => service.dispose());
	t.mock.method(globalThis, "fetch", async (value: string, init: RequestInit) => {
		const url = new URL(value);
		assert.equal(new Headers(init.headers).get("x-review-token"), "secret");
		assert.equal(url.searchParams.get("version"), "3");
		if (url.pathname.endsWith("/diff")) return Response.json([]);
		assert.equal(url.searchParams.get("side"), "base");
		assert.equal(url.searchParams.get("file"), "src/[route].ts");
		return Response.json({ text: "old first line\nold second line" });
	});
	let version = 3;
	let source!: ReviewDiffViewSource;
	let lens!: ReviewDiffLens;
	const canvas = service.canvas(() => view(version), {} as never, {
		openComparison: () => undefined,
		createDocument: (_: unknown, scope: ReviewDiffLens, input: ReviewDiffViewSource) => { lens = scope; source = input; return {}; },
	} as never);
	canvas.inlineEditors.create({ path: "src/[route].ts", side: "base", ranges: [{ startLine: 2, endLine: 2 }] } as never);
	version = 4;
	const result = await source.load(undefined, lens);
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].file.status, "unchanged");
	const model = await readModel(result.entries[0].original!);
	assert.equal(model!.getLineCount(), 2);
	assert.equal(new URLSearchParams(model!.uri.query).get("version"), "3");
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
			openComparison: () => undefined,
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
	const { service, readModel } = setup();
	t.after(() => service.dispose());
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "File is unavailable at the pinned commit." }, { status: 404 }));
	await assert.rejects(Promise.resolve(readModel(apiSourceUri({ view: view(0), side: "head", file: "missing.ts" }))), /unavailable at the pinned commit/);
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

test("a source at its own pins keeps them through its URI and reads them back from the server", async t => {
	const { service, readModel } = setup();
	t.after(() => service.dispose());
	const pins = { repositoryId: "repo-b", head: "b".repeat(40) };
	const anchored = reviewSourceAnchor(reviewSourceComparison(view(3), "c".repeat(40)), pins);
	assert.equal(anchored.commit, undefined);
	const uri = apiSourceUri({ view: anchored, side: "head", file: "src/a.ts" });
	assert.deepEqual(sourceLocation(uri), { view: { reviewId: "review-a", version: 3, generation: undefined, commit: undefined, pins }, side: "head", file: "src/a.ts" });
	const inherited = sourceLocation(apiSourceUri({ view: view(3), side: "head", file: "src/a.ts" }));
	assert.equal(inherited.view.pins, undefined);
	t.mock.method(globalThis, "fetch", async (value: string) => {
		const url = new URL(value);
		assert.equal(url.searchParams.get("repositoryId"), "repo-b");
		assert.equal(url.searchParams.get("head"), pins.head);
		assert.equal(url.searchParams.has("base"), false);
		return Response.json({ text: "at own pins" });
	});
	const model = await readModel(uri);
	assert.equal((model as unknown as { text: string }).text, "at own pins");
});

for (const side of ["base", "head"] as const) {
	test(`binary ${side} source resolves to a notice using plaintext instead of the file language`, async (t) => {
		const { service, readModel, models } = setup();
		t.after(() => service.dispose());
		t.mock.method(globalThis, "fetch", async (value: string) => {
			const url = new URL(value);
			assert.equal(url.searchParams.get("binary"), "describe");
			assert.equal(url.searchParams.get("side"), side);
			return Response.json({ binary: true, file: "image.png", side, commit: "pinned" });
		});
		const uri = apiSourceUri({ view: view(0), side, file: "image.png" });
		await readModel(uri);
		assert.match(models.get(uri.toString())!.text, /Binary file.*cannot be displayed as text/);
		assert.deepEqual(models.get(uri.toString())!.language, { languageId: "plaintext" });
	});
}

test("absent binary diff sides resolve as empty without reading the missing file", async (t) => {
	const { service, readModel, models } = setup();
	t.after(() => service.dispose());
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Absent sides must not request source"); });
	for (const side of ["base", "head"] as const) {
		const uri = apiSourceUri({ view: view(0), side, file: "image.png" }, true);
		await readModel(uri);
		assert.equal(models.get(uri.toString())!.text, "");
	}
});
