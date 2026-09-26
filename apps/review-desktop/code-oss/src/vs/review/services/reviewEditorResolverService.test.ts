import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import type { IOpenWindowOptions, IWindowOpenable } from "../../platform/window/common/window.js";
import { EditorResolverService } from "../../workbench/services/editor/browser/editorResolverService.js";
import { ResolvedStatus } from "../../workbench/services/editor/common/editorResolverService.js";
import { apiSourceUri } from "../common/reviewSourceView.js";
import { REVIEW_LANGUAGE_SOURCE_SCHEME } from "../common/reviewReadonlySource.js";
import { ReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";
import { ReviewEditorResolverService } from "./reviewEditorResolverService.js";

test("source tree, selected code, definitions and diffs hand off before creating a Review editor group", async (t) => {
	const requests: URL[] = [];
	const windows: { openables: IWindowOpenable[]; options: IOpenWindowOptions }[] = [];
	let fail = false;
	t.mock.method(globalThis, "fetch", async (url: string) => {
		const request = new URL(url);
		requests.push(request);
		if (fail) return Response.json({ error: "Checkout unavailable" }, { status: 409 });
		const side = request.searchParams.get("side");
		const file = request.searchParams.get("file");
		return Response.json({ workspacePath: `/navigator/${side}.code-workspace`, filePath: file ? `/navigator/${side}/${file}` : undefined });
	});
	const tabs = new ReviewCanvasEditorTabsService(
		{} as never, { onDidCloseEditor: Event.None } as never, {} as never,
		{ async getConnection() { return { serverUrl: "http://localhost", token: "test" }; } } as never,
		{ async openWindow(openables: IWindowOpenable[], options: IOpenWindowOptions) { windows.push({ openables, options }); } } as never,
		{ warn() {} } as never,
	);
	const resolver = new ReviewEditorResolverService(
		{ get activeGroup() { throw new Error("Review must not create an editor group"); } } as never,
		{ invokeFunction: (fn: (accessor: unknown) => unknown) => fn({ get: () => tabs }) } as never,
		{} as never, {} as never, {} as never,
		{ get: () => "[]", remove() {}, onWillSaveState: Event.None } as never,
		{ onDidRegisterExtensions: Event.None } as never, {} as never,
	);
	t.after(() => { resolver.dispose(); tabs.dispose(); });
	const view = { reviewId: "review-a", version: 7, commit: "selected-commit", pins: { repositoryId: "other-repository", head: "head-sha", base: "base-sha" } };
	const head = apiSourceUri({ view, side: "head", file: "nested/source.ts" });
	const base = apiSourceUri({ view, side: "base", file: "old-name.ts" });
	assert.equal(await resolver.resolveEditor({ resource: head }, undefined), ResolvedStatus.ABORT);
	assert.equal(await resolver.resolveEditor({ resource: base, options: { selection: { startLineNumber: 42, startColumn: 3 } } }, undefined), ResolvedStatus.ABORT);
	assert.deepEqual(windows[1].openables, [
		{ workspaceUri: URI.file("/navigator/base.code-workspace") },
		{ fileUri: URI.file("/navigator/base/old-name.ts:42:3") },
	]);
	assert.deepEqual(windows[1].options, { forceNewWindow: true, gotoLineMode: true });
	assert.equal(requests[1].searchParams.get("version"), "7");
	assert.equal(requests[1].searchParams.get("commit"), "selected-commit");
	assert.equal(requests[1].searchParams.get("repositoryId"), "other-repository");
	assert.equal(requests[1].searchParams.get("base"), "base-sha");
	const dependency = head.with({ scheme: REVIEW_LANGUAGE_SOURCE_SCHEME, path: "/prepared/node_modules/lib/index.d.ts" });
	assert.equal(await resolver.resolveEditor({ resource: dependency }, undefined), ResolvedStatus.ABORT);
	assert.deepEqual(windows[2].openables[1], { fileUri: URI.file(dependency.path) });
	assert.equal(requests[2].searchParams.has("file"), false);
	assert.equal(await resolver.resolveEditor({ original: { resource: base }, modified: { resource: head } }, undefined), ResolvedStatus.ABORT);
	// The source window compares both sides itself, so a diff opens its head file.
	assert.deepEqual(windows[3].openables, [
		{ workspaceUri: URI.file("/navigator/head.code-workspace") },
		{ fileUri: URI.file("/navigator/head/nested/source.ts") },
	]);
	assert.equal(requests.length, 4);
	const deleted = apiSourceUri({ view, side: "head", file: "old-name.ts" }, true);
	await resolver.resolveEditor({ original: { resource: base }, modified: { resource: deleted } }, undefined);
	assert.equal(requests[4].searchParams.get("side"), "head");
	assert.equal(requests[4].searchParams.get("empty"), "true");
	fail = true;
	await assert.rejects(resolver.resolveEditor({ resource: head }, undefined), /Checkout unavailable/);
	assert.equal(windows.length, 5);
	const stock = t.mock.method(EditorResolverService.prototype, "resolveEditor", async () => ResolvedStatus.NONE);
	const settings = { resource: URI.parse("vscode-settings:/settings") };
	assert.equal(await resolver.resolveEditor(settings, undefined), ResolvedStatus.NONE);
	assert.equal(stock.mock.calls[0].arguments[0], settings);
});
