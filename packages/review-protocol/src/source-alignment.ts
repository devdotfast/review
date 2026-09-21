import type {
  StructuralDiff,
  StructuralRegion,
  StructuralSource,
} from "./diffr-contract.js";

type AlignmentLeaf = Extract<StructuralRegion, { kind: "leaf" }>;

/** The 0-based, half-open line span a region touches. An end at column 0 does not touch its end line. */
function alignmentRegionLines(region: StructuralRegion) {
  return {
    start: region.start.line,
    end: region.end.column === 0 ? region.end.line : region.end.line + 1,
  };
}

function alignmentLeaves(
  regions: readonly StructuralRegion[] | undefined,
): AlignmentLeaf[] {
  const leaves: AlignmentLeaf[] = [];

  const walk = (region: StructuralRegion) => {
    if (region.kind === "leaf") leaves.push(region);
    else for (const child of region.children) walk(child);
  };

  for (const region of regions ?? []) walk(region);

  return leaves;
}

/** Monaco keeps a final empty line after a newline; the wire need not mention it. */
function monacoLineCount(source: StructuralSource | undefined): number {
  return source ? source.text.split("\n").length : 0;
}

/**
 * Zips the two sides' leaves by `alignment_id` into the full row table. Paired leaves
 * yield rows line for line, in the same order on both sides; an unpaired leaf
 * yields one-sided rows. Rows past the last leaf pair the trailing empty
 * lines Monaco keeps.
 */
export function structuralRows(
  diff: Extract<StructuralDiff, { type: "text" }>,
): [number | null, number | null][] {
  const lhsLeaves = alignmentLeaves(diff.lhs?.regions);
  const rhsLeaves = alignmentLeaves(diff.rhs?.regions);
  const leftCount = monacoLineCount(diff.lhs);
  const rightCount = monacoLineCount(diff.rhs);
  const rows: [number | null, number | null][] = [];

  let left = 0,
    right = 0;

  const push = (l: number | null, r: number | null) => {
    rows.push([l, r]);

    if (l !== null) left = l + 1;

    if (r !== null) right = r + 1;
  };

  const oneSided = (leaf: AlignmentLeaf, side: 0 | 1) => {
    const lines = alignmentRegionLines(leaf);

    for (let line = lines.start; line < lines.end; line++)
      push(side === 0 ? line : null, side === 1 ? line : null);
  };

  const rhsIndex = new Map(
    rhsLeaves.map((leaf, index) => [leaf.alignment_id, index] as const),
  );

  let cursor = 0;

  for (const leaf of lhsLeaves) {
    const partner = rhsIndex.get(leaf.alignment_id);

    if (partner === undefined) {
      oneSided(leaf, 0);
      continue;
    }

    while (cursor < partner) oneSided(rhsLeaves[cursor++], 1);
    const a = alignmentRegionLines(leaf);
    const b = alignmentRegionLines(rhsLeaves[partner]);

    for (let offset = 0; offset < a.end - a.start; offset++)
      push(a.start + offset, b.start + offset);
    cursor = partner + 1;
  }

  while (cursor < rhsLeaves.length) oneSided(rhsLeaves[cursor++], 1);

  while (left < leftCount || right < rightCount) {
    rows.push([
      left < leftCount ? left++ : null,
      right < rightCount ? right++ : null,
    ]);
  }

  return rows;
}
