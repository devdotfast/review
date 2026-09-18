/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../base/common/uri.js";

// The hover and go-to-symbol contributions this service uses are browser modules.
Object.assign(globalThis, {
	window: globalThis,
	location: { href: "http://localhost/" },
	HTMLElement: class { },
	customElements: { define() { }, get: () => undefined },
	document: { createElement: () => ({ style: {}, classList: { add() { }, remove() { } } }), addEventListener() { } },
	matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
});
const { ReviewLocalLanguageFeatures } = await import("./reviewLocalLanguageFeatures.js");

const disposable = { dispose() { } };
const untilLanguage = async (order: string[], steps = 200) => {
	for (let i = 0; i < steps && !order.includes("language"); i++) await new Promise(resolve => setTimeout(resolve, 10));
};

function setup(order: string[], context: unknown, exists = true) {
	const pinned = {
		uri: URI.parse("review-api-source://review-a/src/lib.rs?version=1&side=head"),
		isDisposed: () => false,
		getLanguageId: () => "plaintext",
		getLineContent: () => "use std::io;",
		setLanguage: () => { order.push("language"); },
		onWillDispose: () => disposable,
	};
	const features = new ReviewLocalLanguageFeatures(
		{ onDidChangeConnection: () => disposable, getConnection: async () => ({ serverUrl: "http://localhost:5570", token: "secret" }) } as never,
		{ createModelReference: async (uri: URI) => ({ object: { textEditorModel: { uri, getLanguageId: () => "rust", onDidChangeContent: () => disposable } }, dispose() { } }) } as never,
		{ onModelAdded: () => disposable, getModels: () => [pinned] } as never,
		{
			hoverProvider: { register: () => disposable }, definitionProvider: { register: () => disposable },
			typeDefinitionProvider: { register: () => disposable }, implementationProvider: { register: () => disposable },
			referenceProvider: { register: () => disposable },
		} as never,
		{ activateByEvent: async (event: string) => { order.push(`activate:${event}`); } } as never,
		{ addFolders: async () => { order.push("folder"); }, removeFolders: async () => { } } as never,
		{ files: { models: [], resolve: async () => { } } } as never,
		{ exists: async () => exists, onDidFilesChange: () => disposable } as never,
		{ unifiedResource: () => undefined } as never,
		{ debug() { } } as never,
		{ createByFilepathOrFirstLine: () => ({ languageId: "rust", onDidChange: () => disposable }) } as never,
	);
	return { features, fetch: async () => Response.json(context) };
}

test("a review's checkout is a workspace folder before the peek model gets its language", async (t) => {
	const order: string[] = [];
	const { features, fetch } = setup(order, { rootPath: "/tmp/review-checkout", identity: "checkout-1" });
	t.after(() => features.dispose());
	t.mock.method(globalThis, "fetch", fetch);

	await untilLanguage(order);

	assert.deepEqual(order, ["folder", "activate:onLanguage:rust", "language"]);
});

test("a peek without a local checkout still gets its language", async (t) => {
	const order: string[] = [];
	const { features, fetch } = setup(order, { rootPath: null });
	t.after(() => features.dispose());
	t.mock.method(globalThis, "fetch", fetch);

	await untilLanguage(order);

	assert.deepEqual(order, ["language"]);
});

test("a peek whose file is missing from the checkout still gets its language", async (t) => {
	const order: string[] = [];
	const { features, fetch } = setup(order, { rootPath: "/tmp/review-checkout", identity: "checkout-1" }, false);
	t.after(() => features.dispose());
	t.mock.method(globalThis, "fetch", fetch);

	await untilLanguage(order);

	assert.deepEqual(order, ["language"]);
});
