import type { ILineChange } from '../../../editor/common/diff/legacyLinesDiffComputer.js';
import type { WhiteboardSurfaceEvent } from '../../common/whiteboardProtocol.js';

type SelectedDiff = NonNullable<Extract<WhiteboardSurfaceEvent, { event: 'editorSelectionChanged' }>['selectedDiff']>;
interface Lines { getLineCount(): number; getLineContent(line: number): string }

/** Expand intersected replacements to both sides so the copied excerpt is a real diff. */
export function selectedMonacoDiff(original: Lines, modified: Lines, changes: readonly Omit<ILineChange, 'charChanges'>[], side: 'base' | 'head', from: number, to: number, oldPath: string, newPath: string): SelectedDiff | undefined {
	const result: SelectedDiff = { oldPath, newPath, oldStart: 0, newStart: 0, rows: [] };
	let oldLine = 1, newLine = 1;
	const begin = (oldStart: number, newStart: number) => {
		if (!result.rows.length) { result.oldStart = oldStart; result.newStart = newStart; }
	};
	const context = (count: number) => {
		const line = side === 'base' ? oldLine : newLine;
		const first = Math.max(0, from - line), last = Math.min(count - 1, to - line);
		if (first <= last) {
			begin(oldLine + first, newLine + first);
			for (let offset = first; offset <= last; offset++) result.rows.push({ kind: 'unchanged', text: original.getLineContent(oldLine + offset) });
		}
		oldLine += count; newLine += count;
	};
	for (const change of changes) {
		const oldStart = change.originalEndLineNumber === 0 ? change.originalStartLineNumber + 1 : change.originalStartLineNumber;
		const newStart = change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : change.modifiedStartLineNumber;
		const oldCount = change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - oldStart + 1;
		const newCount = change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - newStart + 1;
		context(Math.max(0, Math.min(oldStart - oldLine, newStart - newLine)));
		const start = side === 'base' ? oldStart : newStart;
		const count = side === 'base' ? oldCount : newCount;
		// A one-sided change belongs only when the selection crosses its insertion point.
		if (count ? from <= start + count - 1 && to >= start : from < start && to >= start) {
			const selectedOldStart = !newCount && side === 'base' ? Math.max(oldStart, from) : oldStart;
			const selectedOldEnd = !newCount && side === 'base' ? Math.min(oldStart + oldCount, to + 1) : oldStart + oldCount;
			const selectedNewStart = !oldCount && side === 'head' ? Math.max(newStart, from) : newStart;
			const selectedNewEnd = !oldCount && side === 'head' ? Math.min(newStart + newCount, to + 1) : newStart + newCount;
			begin(oldCount ? selectedOldStart : oldStart - 1, newCount ? selectedNewStart : newStart - 1);
			for (let line = selectedOldStart; line < selectedOldEnd; line++) result.rows.push({ kind: 'deleted', text: original.getLineContent(line) });
			for (let line = selectedNewStart; line < selectedNewEnd; line++) result.rows.push({ kind: 'added', text: modified.getLineContent(line) });
		}
		oldLine = oldStart + oldCount; newLine = newStart + newCount;
	}
	context(Math.max(0, Math.min(oldPath ? original.getLineCount() - oldLine + 1 : 0, newPath ? modified.getLineCount() - newLine + 1 : 0)));
	return result.rows.length ? result : undefined;
}
