import assert from "node:assert/strict";
import test from "node:test";

import { URI } from "../../../base/common/uri.js";
import { Selection } from "../../../editor/common/core/selection.js";
import { apiSourceUri } from "../../services/whiteboardApiSourceService.js";
import { apiSelectionEvent } from "./whiteboardApiSelection.js";

test("API diff selections retain side, version and commit without a legacy session", () => {
	for (const side of ["base", "head"] as const) {
		const resource = apiSourceUri({ view: { sessionId: "review-a", version: 7, commit: "selected-commit" }, side, file: "src/[route].ts" });
		for (const selection of [new Selection(2, 1, 4, 1), new Selection(4, 1, 2, 1)]) {
			assert.deepEqual(apiSelectionEvent(resource, selection, { x: 70, y: 140 }), {
				event: "editorSelectionChanged", sessionId: "review-a", anchor: { x: 70, y: 140 },
				path: "src/[route].ts", sideContext: side, isEmpty: false,
				range: { fromLine: 2, toLine: 3 },
				apiSource: { sessionId: "review-a", version: 7, commit: "selected-commit" },
			});
		}
		assert.equal(apiSelectionEvent(resource, new Selection(2, 1, 2, 1))?.isEmpty, true);
	}
});

test("empty diff sides and unrelated resources cannot produce source-copy actions", () => {
	const empty = apiSourceUri({ view: { sessionId: "review-a", version: 0 }, side: "base", file: "new.ts" }, true);
	const selection = new Selection(1, 1, 2, 1);
	assert.equal(apiSelectionEvent(empty, selection), undefined);
	assert.equal(apiSelectionEvent(URI.file("/tmp/file.ts"), selection), undefined);
});
