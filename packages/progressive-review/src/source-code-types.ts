/** Source-view types used by range-only code peeks. */

export interface SourceToken {
  t: string;
  k: SourceTokenKind;
}

export type SourceTokenKind =
  | "kw"
  | "id"
  | "fn"
  | "str"
  | "num"
  | "com"
  | "op"
  | "w"
  | "t";

export interface SourceRangeSummary {
  id: string;
  name: string;
  kind: "source-range";
  file: string;
  line: number;
  endLine: number;
}

export interface ResolvedSourceRange {
  source: SourceRangeSummary;
  lines: SourceToken[][];
}

export interface SourcePane {
  kind: "source";
  sourceId: string;
}

export interface SourceSnapshot {
  roots: SourcePane[];
  resolved: Record<string, ResolvedSourceRange>;
}

export interface SourceLineComment {
  rootIndex: number;
  path: string[];
  file: string;
  line: number;
  sourceId?: string;
  count: number;
}
