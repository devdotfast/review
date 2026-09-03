/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Emitter } from "../../../base/common/event.js";
import { extUri } from "../../../base/common/resources.js";
import { URI } from "../../../base/common/uri.js";
import { ReviewWorkspaceFolderContribution } from "./reviewWorkspaceFolder.contribution.js";

interface StubFolder {
	readonly uri: URI;
	readonly name: string;
}

/** One entry of `IReviewSessionModelService.activeModel`. */
function model(sessionId: string, headRootPath: string, title: string) {
	return {
		session: {
			session: {
				sessionId,
				rootPath: `${headRootPath}-worktree`,
				headRootPath,
			},
			review: { title },
		},
	};
}

/**
 * Mounts the contribution over recording stubs. Every stub is a Proxy so the
 * test can see the whole set of service methods the contribution reaches for,
 * not only the ones it was asked about.
 */
function createHarness(initial: ReturnType<typeof model> | null) {
	const calls: string[] = [];
	let folders: StubFolder[] = [];
	const record = <T extends object>(name: string, target: T): T =>
		new Proxy(target, {
			get(object, property, receiver) {
				const value = Reflect.get(object, property, receiver);
				if (typeof value === "function") {
					return (...args: unknown[]) => {
						calls.push(`${name}.${String(property)}`);
						return (value as (...rest: unknown[]) => unknown).apply(
							object,
							args,
						);
					};
				}
				return value;
			},
		});

	const activeModelChange = new Emitter<ReturnType<typeof model> | null>();
	let activeModel = initial;
	const contribution = new ReviewWorkspaceFolderContribution(
		record("sessionModelService", {
			get activeModel() {
				return activeModel;
			},
			onDidChangeActiveModel: activeModelChange.event,
		}) as never,
		record("uriIdentityService", { extUri }) as never,
		record("workspaceContextService", {
			getWorkspace: () => ({ folders }),
		}) as never,
		record("workspaceEditingService", {
			async addFolders(added: StubFolder[]) {
				folders = [...folders, ...added];
			},
			async updateFolders(
				index: number,
				deleteCount: number,
				added: StubFolder[] = [],
			) {
				folders = [
					...folders.slice(0, index),
					...added,
					...folders.slice(index + deleteCount),
				];
			},
			async removeFolders(removed: URI[]) {
				folders = folders.filter(
					(folder) =>
						!removed.some((uri) => uri.toString() === folder.uri.toString()),
				);
			},
		}) as never,
		record("logService", { trace() {} }) as never,
	);

	return {
		contribution,
		calls,
		folders: () => folders,
		async activate(next: ReturnType<typeof model> | null) {
			activeModel = next;
			activeModelChange.fire(next);
			await flush();
		},
	};
}

/** Lets the contribution's serialising queue drain. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

test("the workspace folder is seeded from the session already active", async () => {
	// A reloaded window starts with no folders and may have missed the
	// active-model event, so the contribution has to read the current value.
	const harness = createHarness(
		model("session-1", "/tmp/review-head", "Fix the parser"),
	);
	await flush();

	assert.deepEqual(
		harness.folders().map((folder) => [folder.uri.fsPath, folder.name]),
		[["/tmp/review-head", "Fix the parser"]],
	);
	assert.deepEqual(
		harness.calls.filter((call) => call.startsWith("workspaceEditingService.")),
		["workspaceEditingService.addFolders"],
	);
	harness.contribution.dispose();
});

test("switching sessions replaces the folder in one update, without restarting the extension host", async () => {
	const harness = createHarness(
		model("session-1", "/tmp/review-head", "Fix the parser"),
	);
	await flush();
	await harness.activate(
		model("session-2", "/tmp/other-head", "Rename the widget"),
	);

	assert.deepEqual(
		harness.folders().map((folder) => [folder.uri.fsPath, folder.name]),
		[["/tmp/other-head", "Rename the widget"]],
	);
	// One `updateFolders` rather than a remove then an add: a language server
	// must see one folder transition, not an empty workspace in between.
	assert.deepEqual(
		harness.calls.filter((call) => call.startsWith("workspaceEditingService.")),
		[
			"workspaceEditingService.addFolders",
			"workspaceEditingService.updateFolders",
		],
	);
	// The folder shim mutates in memory. Reaching for a host restart or a window
	// reload would drop every warm language server on each session switch.
	for (const forbidden of [
		"stopExtensionHosts",
		"startExtensionHosts",
		"reloadWindow",
		"reload",
		"restart",
	]) {
		assert.equal(
			harness.calls.some((call) => call.endsWith(`.${forbidden}`)),
			false,
			`${forbidden} was called`,
		);
	}
	harness.contribution.dispose();
});

test("an unchanged repository leaves the folder alone", async () => {
	const harness = createHarness(
		model("session-1", "/tmp/review-head", "Fix the parser"),
	);
	await flush();
	// A second session over the same checkout: the folder is already right, so
	// re-setting it would fire a folder-change event for nothing.
	await harness.activate(
		model("session-2", "/tmp/review-head", "Fix the parser"),
	);

	assert.deepEqual(
		harness.calls.filter((call) => call.startsWith("workspaceEditingService.")),
		["workspaceEditingService.addFolders"],
	);
	harness.contribution.dispose();
});

test("closing the last session removes the folder", async () => {
	const harness = createHarness(
		model("session-1", "/tmp/review-head", "Fix the parser"),
	);
	await flush();
	await harness.activate(null);

	assert.deepEqual(harness.folders(), []);
	assert.deepEqual(
		harness.calls.filter((call) => call.startsWith("workspaceEditingService.")),
		[
			"workspaceEditingService.addFolders",
			"workspaceEditingService.removeFolders",
		],
	);
	harness.contribution.dispose();
});
