import type { ReactElement } from "react";

export const compactDiffCount = (count: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(count)
    .toLowerCase();

/**
 * The one way a +n −n pair is written anywhere in the app: the add and
 * delete tokens, tabular mono at 11px, compact past 999. Cards, meta lines,
 * commit rows, lens rows and the progress line all render this.
 */
export function DiffCount({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}): ReactElement {
  return (
    <span className="diff-counts">
      <span className="diff-count-added">+{compactDiffCount(additions)}</span>
      <span className="diff-count-removed">−{compactDiffCount(deletions)}</span>
    </span>
  );
}
