import assert from "node:assert/strict";
import test from "node:test";

import { Position } from "../../editor/common/core/position.js";
import { Range } from "../../editor/common/core/range.js";
import { DefaultLinesDiffComputer } from "../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";
import { ReviewLocalLineMapping } from "./reviewLocalLineMapping.js";

function mapping(originalText: string, localText: string, quitEarly = false) {
	const original = originalText.split(/\r?\n/), local = localText.split(/\r?\n/);
	const diff = new DefaultLinesDiffComputer().computeDiff(original, local, { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 1000 });
	return new ReviewLocalLineMapping({ getLineCount: () => original.length }, { getLineCount: () => local.length }, {
		changes: diff.changes, moves: diff.moves, identical: originalText === localText, quitEarly,
	});
}

test("maps unchanged code past staged/unstaged insertions without changing UTF-16 columns", () => {
	const source = 'import { lookup } from "./lib";\r\n\tconst label = "😀 café"; lookup();\r\n';
	const local = '// staged\n// unstaged\n' + source;
	const map = mapping(source, local);
	const column = source.split('\r\n')[1].indexOf('lookup') + 1;
	assert.deepEqual(map.toLocal(new Position(2, column)), new Position(4, column));
	assert.deepEqual(map.toReview(new Range(4, column, 4, column + 6)), new Range(2, column, 2, column + 6));
});

test("never clamps deleted or replaced lines onto a different symbol", () => {
	const map = mapping('start();\noldName();\nend();', 'start();\nnewName();\nend();');
	assert.equal(map.toLocal(new Position(2, 1)), undefined);
	assert.equal(map.toReview(new Range(2, 1, 2, 4)), undefined);
	assert.equal(mapping('start();\noldName();\nend();', 'start();\nend();').toLocal(new Position(2, 1)), undefined);
});

test("duplicate names stay aligned with their surrounding scope", () => {
	const source = 'function left() {\n  lookup();\n}\nfunction right() {\n  lookup();\n}';
	const map = mapping(source, '// inserted\n' + source);
	assert.deepEqual(map.toLocal(new Position(2, 3)), new Position(3, 3));
	assert.deepEqual(map.toLocal(new Position(5, 3)), new Position(6, 3));
});

test("refuses approximate diff results and ranges spanning changed text", () => {
	assert.equal(mapping('lookup();', 'lookup();', true).toLocal(new Position(1, 1)), undefined);
	const map = mapping('one();\ntwo();', 'one();\ninserted();\ntwo();');
	assert.equal(map.toReview(new Range(1, 1, 3, 4)), undefined);
});
