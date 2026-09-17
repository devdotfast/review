import { Position } from "../../editor/common/core/position.js";
import { Range } from "../../editor/common/core/range.js";
import type { IDocumentDiff } from "../../editor/common/diff/documentDiffProvider.js";
import { LineRangeMapping } from "../../editor/common/diff/rangeMapping.js";
import type { ITextModel } from "../../editor/common/model.js";

/** Unlike peek window alignment, language queries must never clamp a changed line. */
export class ReviewLocalLineMapping {
	private readonly unchanged: LineRangeMapping[];

	constructor(original: Pick<ITextModel, "getLineCount">, local: Pick<ITextModel, "getLineCount">, diff: IDocumentDiff) {
		this.unchanged = diff.quitEarly ? [] : LineRangeMapping.inverse(diff.changes, original.getLineCount(), local.getLineCount());
	}

	toLocal(position: Position): Position | undefined {
		const match = this.unchanged.find(range => range.original.contains(position.lineNumber));
		return match && new Position(position.lineNumber + match.modified.startLineNumber - match.original.startLineNumber, position.column);
	}

	toReview(range: Range): Range | undefined {
		const match = this.unchanged.find(mapping => mapping.modified.contains(range.startLineNumber) && mapping.modified.contains(range.endLineNumber));
		if (!match) return undefined;
		const offset = match.original.startLineNumber - match.modified.startLineNumber;
		return new Range(range.startLineNumber + offset, range.startColumn, range.endLineNumber + offset, range.endColumn);
	}
}
