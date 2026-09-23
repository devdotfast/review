/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import { WhiteboardCanvasEditorInput } from "../browser/parts/canvas/whiteboardCanvasEditorInput.js";
import { WhiteboardCanvasEditorTabsService } from "./whiteboardCanvasEditorTabsService.js";

async function closeWelcome(updateNeeded: boolean): Promise<number> {
	let finished = 0;
	const instantiation = {
		createInstance(_ctor: unknown, target: never) {
			return new WhiteboardCanvasEditorInput(target, {} as never);
		},
	};
	const editors = { onDidCloseEditor: Event.None, async openEditor() {} };
	const groups = { groups: [], mainPart: { activeGroup: undefined } };
	const connection = {
		async getCliInstallStatus() {
			return { updateNeeded };
		},
		async finishCliInstallUpdate() {
			finished += 1;
		},
	};
	const tabs = new WhiteboardCanvasEditorTabsService(
		instantiation as never,
		editors as never,
		groups as never,
		connection as never,
		{ warn() {} } as never,
	);
	try {
		const welcome = await tabs.openWelcome(true);
		welcome.dispose();
		await new Promise((resolve) => setImmediate(resolve));
		return finished;
	} finally {
		tabs.dispose();
	}
}

test("closing Welcome finishes the CLI install update only when one is pending", async () => {
	assert.equal(await closeWelcome(true), 1);
	assert.equal(await closeWelcome(false), 0);
});
