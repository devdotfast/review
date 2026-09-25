import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { Disposable } from "../../base/common/lifecycle.js";
import { Position } from "../../editor/common/core/position.js";
import { URI } from "../../base/common/uri.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM("<html><body></body></html>");
for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "Node", "MutationObserver", "Element", "navigator", "customElements", "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } }) as never;
registerHooks({ load(url, context, next) {
	return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
} });
const { ReviewLocalLanguageFeatures } = await import("./reviewLocalLanguageFeatures.js");

function event<T>() {
	const listeners = new Set<(value: T) => void>();
	return {
		event: (listener: (value: T) => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
		fire(value: T) { for (const listener of [...listeners]) listener(value); },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

function model(attached = false) {
	const changed = event<void>();
	const disposed = event<void>();
	let isDisposed = false;
	const text = "same pinned source";
	return {
		uri: URI.parse("review-api-source://review/src/file.ts?version=1"),
		isAttachedToEditor: () => attached,
		isDisposed: () => isDisposed,
		getVersionId: () => 1,
		getTextBuffer: () => text,
		getEOL: () => "\n",
		equalsTextBuffer: (other: string) => other === text,
		onDidChangeAttached: changed.event,
		onWillDispose: disposed.event,
		setAttached(value: boolean) { attached = value; changed.fire(); },
		dispose() { isDisposed = true; disposed.fire(); },
	} as any;
}

function setup(input: ReturnType<typeof model> | ReturnType<typeof model>[]) {
	const sourceModels = Array.isArray(input) ? input : [input];
	const added = event<any>();
	const modelService = { getModels: () => sourceModels, onModelAdded: added.event, createModelReference: async () => { throw new Error("unexpected model reference"); } };
	const languages = Object.fromEntries(["hoverProvider", "definitionProvider", "typeDefinitionProvider", "implementationProvider", "referenceProvider"].map(key => [key, {
		register: () => Disposable.None,
		ordered: () => [],
	}])) as any;
	const local = {
		uri: URI.file("/project/src/file.ts"),
		isDisposed: () => false,
		getVersionId: () => 1,
		getTextBuffer: () => "same pinned source",
		getEOL: () => "\n",
		equalsTextBuffer: (other: string) => other === "same pinned source",
	};
	const service = new ReviewLocalLanguageFeatures(
		{ onDidChangeConnection: () => Disposable.None } as any,
		{ createModelReference: async (uri: URI) => ({ object: { textEditorModel: { ...local, uri } }, dispose() { } }) } as any,
		modelService as any,
		languages,
		{ activateByEvent: async () => undefined } as any,
		{} as any,
		{ files: { models: [], resolve: async () => undefined } } as any,
		{ onDidFilesChange: () => Disposable.None, exists: async () => true } as any,
		{ debug() { } } as any,
	);
	return { service, sourceModel: sourceModels[0], sourceModels, local };
}

function source(local: any) {
	let references = 1;
	let disposed = false;
	const disposal = deferred<void>();
	const release = () => {
		if (!disposed && --references === 0) { disposed = true; disposal.resolve(); }
	};
	const source = {
		identity: "identity",
		root: URI.file("/project"),
		reference: { object: { textEditorModel: local }, dispose() { } },
		retain() {
			if (disposed) return undefined;
			references++;
			let released = false;
			return { dispose() { if (!released) { released = true; release(); } } };
		},
		dispose: release,
		isDisposed: () => disposed,
		waitDisposed: () => disposal.promise,
	};
	return source;
}

test("cancellation while acquiring a review source releases the newly acquired native model", async (t) => {
	const setupResult = setup(model());
	t.after(() => setupResult.service.dispose());
	const acquisition = deferred<any>();
	const started = deferred<void>();
	const actualSource = source(setupResult.local);
	const internal = setupResult.service as any;
	internal.environment = async () => ({ rootPath: "/project", identity: "identity" });
	internal.acquire = async () => { started.resolve(); return acquisition.promise; };
	const token = { isCancellationRequested: false };
	const pending = internal.withSource(setupResult.sourceModel, new Position(1, 1), token, async () => "should not run");
	await started.promise;
	token.isCancellationRequested = true;
	acquisition.resolve(actualSource);
	assert.equal(await pending, undefined);
	assert.equal(actualSource.isDisposed(), true, "the canceled request drops both its temporary retain and detached owner");
});

test("detaching during an in-flight definition keeps its captured source until mapping completes", async (t) => {
	const setupResult = setup(model());
	t.after(() => setupResult.service.dispose());
	const acquisition = deferred<any>();
	const started = deferred<void>();
	const entered = deferred<void>();
	const acquired = source(setupResult.local);
	const internal = setupResult.service as any;
	internal.environment = async () => ({ rootPath: "/project", identity: "identity" });
	internal.acquire = async () => { started.resolve(); return acquisition.promise; };
	setupResult.sourceModel.setAttached(true);
	await started.promise;
	const mapping = deferred<string>();
	let capturedSource: unknown;
	const request = internal.withSource(setupResult.sourceModel, new Position(1, 1), { isCancellationRequested: false }, async (_local: unknown, _at: unknown, _review: unknown, captured: unknown) => {
		assert.equal(captured, acquired);
		capturedSource = captured;
		entered.resolve();
		return mapping.promise;
	});
	acquisition.resolve(acquired);
	await entered.promise;
	setupResult.sourceModel.setAttached(false);
	assert.equal(acquired.isDisposed(), false, "the request retain survives detachment and source-map eviction");
	const locations = await internal.reviewLocations(setupResult.sourceModel, [{ uri: URI.file("/project/src/target.ts") }], { isCancellationRequested: false }, capturedSource);
	assert.equal(locations[0].uri.scheme, "review-api-source", "definition mapping uses the source retained by this request after map eviction");
	mapping.resolve("mapped result");
	assert.equal(await request, "mapped result");
	assert.equal(acquired.isDisposed(), true, "mapping completion releases the final source reference");
});

test("hundreds of unattached pinned models allocate no native source models; detaching releases the visible model", async (t) => {
	const setupResult = setup(Array.from({ length: 800 }, () => model()));
	t.after(() => setupResult.service.dispose());
	const acquired = source(setupResult.local);
	const internal = setupResult.service as any;
	internal.environment = async () => ({ rootPath: "/project", identity: "identity" });
	let acquireCount = 0;
	internal.acquire = async () => { acquireCount++; return acquired; };
	assert.equal(acquireCount, 0, "the pinned comparison is not eagerly resolved into 800 native working copies");
	setupResult.sourceModel.setAttached(true);
	await internal.localSource(setupResult.sourceModel, true);
	assert.equal(acquireCount, 1);
	setupResult.sourceModel.setAttached(false);
	await acquired.waitDisposed();
	assert.equal(acquired.isDisposed(), true);
});

test("disposing a review model or the service releases its warm native source", async (t) => {
	for (const disposeOwner of ["model", "service"] as const) {
		const result = setup(model());
		const acquired = source(result.local);
		const internal = result.service as any;
		internal.environment = async () => ({ rootPath: "/project", identity: "identity" });
		internal.acquire = async () => acquired;
		result.sourceModel.setAttached(true);
		await internal.localSource(result.sourceModel, true);
		if (disposeOwner === "model") result.sourceModel.dispose();
		else result.service.dispose();
		await acquired.waitDisposed();
		assert.equal(acquired.isDisposed(), true, `${disposeOwner} disposal releases the working copy`);
		result.service.dispose();
	}
});
