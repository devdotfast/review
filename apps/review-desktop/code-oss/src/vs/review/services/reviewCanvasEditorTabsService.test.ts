/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import type { ReviewDescriptor } from "../common/reviewProtocol.js";
import { ReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const review: ReviewDescriptor = {
	uuid,
	title: "Open once",
	status: "awaiting-review",
	worktreePath: "/tmp/review",
	repoKey: "repo",
	sourceBranch: "feature",
	presentedDocumentRevision: "a".repeat(40),
	presentedSoftwareMapRevision: null,
	lastPublishedAt: "2026-09-03T00:00:00.000Z",
	available: true,
	viewedAt: null,
	dismissedAt: null,
	reapsAt: null,
};

interface FakeGroup {
	readonly id: number;
	contains(candidate: unknown): boolean;
}

function serviceWith(
	groups: FakeGroup[],
	activeGroup: FakeGroup,
	opened: unknown[][],
): { service: ReviewCanvasEditorTabsService; input: object } {
	const input = { isDisposed: () => false, preferSession: () => undefined };
	const service = new ReviewCanvasEditorTabsService(
		{ createInstance: () => input } as never,
		{
			onDidCloseEditor: Event.None,
			openEditor: async (...args: unknown[]) => {
				opened.push(args);
				return undefined;
			},
		} as never,
		{ mainPart: { activeGroup, getGroups: () => groups } } as never,
		{ reviews: [review], reviewErrors: [] } as never,
	);
	return { service, input };
}

test("a review that is open elsewhere is revealed in that group", async () => {
	const opened: unknown[][] = [];
	const focused: FakeGroup = { id: 1, contains: () => false };
	const holder: FakeGroup = { id: 2, contains: () => true };
	const { service, input } = serviceWith([focused, holder], focused, opened);

	await service.openReview(uuid, true);

	assert.deepEqual(opened, [[input, { pinned: true, inactive: false }, holder]]);
	service.dispose();
});

test("a first open lands in the active group", async () => {
	const opened: unknown[][] = [];
	const focused: FakeGroup = { id: 1, contains: () => false };
	const other: FakeGroup = { id: 2, contains: () => false };
	const { service, input } = serviceWith([focused, other], focused, opened);

	await service.openReview(uuid, false);

	assert.deepEqual(opened, [[input, { pinned: true, inactive: true }, focused]]);
	service.dispose();
});
