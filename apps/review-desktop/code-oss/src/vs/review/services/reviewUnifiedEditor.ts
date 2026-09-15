import { Range } from "../../editor/common/core/range.js";
import type { IModelDeltaDecoration } from "../../editor/common/model.js";
import type { ReviewUnifiedDiffRow } from "../common/reviewUnifiedDiff.js";

export function reviewUnifiedDiffDecorations(rows: readonly ReviewUnifiedDiffRow[]): IModelDeltaDecoration[] {
  return rows.flatMap((row) => {
    if (row.kind === "unchanged") return [];
    const added = row.kind === "added";
    return [{
      range: new Range(row.lineNumber, 1, row.lineNumber, Number.MAX_SAFE_INTEGER),
      options: {
        description: `Review unified ${row.kind} line`,
        isWholeLine: true,
        className: added ? "line-insert" : "line-delete",
        marginClassName: added ? "gutter-insert" : "gutter-delete",
        lineNumberClassName: added ? "review-unified-line-number-added" : "review-unified-line-number-deleted",
      },
    }];
  });
}

export function reviewUnifiedLineNumbers(rows: readonly ReviewUnifiedDiffRow[]): (lineNumber: number) => string {
  return (lineNumber) => String(rows[lineNumber - 1]?.authorLine ?? lineNumber);
}
