import type { RegionData, SearchResultData, SourceData, ReviewInlineEditorSpec } from './reviewProtocol.js';
import type { ReviewUnifiedDiffRow } from './reviewUnifiedDiff.js';

export interface EvidenceRow extends ReviewUnifiedDiffRow {
  highlights: { startColumn: number; endColumn: number }[];
  fold?: { id: number; collapsed: boolean };
}
interface Item {
  key: string;
  line: number;
  text: string;
  changed: boolean;
  highlights: EvidenceRow['highlights'];
  fold?: EvidenceRow['fold'];
}

function items(source: SourceData): Item[] {
  const lines = source.text.split('\n').map(line => line.replace(/\r$/, ''));
  const output: Item[] = [];
  const column = (text: string, byte: number) => new TextDecoder().decode(new TextEncoder().encode(text).slice(0, byte)).length + 1;
  const walk = (regions: RegionData[]) => {
    for (const region of regions) {
      const first = output.length;
      const end = region.end.line + Number(region.end.column > 0);
      if (region.visibility?.collapsed) {
        output.push({key: `fold:${region.fold_state_id}`, line: region.start.line + 1,
          text: `… ${region.visibility.label || `${region.start.line + 1}–${end}`} …`, changed: false, highlights: [],
          fold: {id: region.fold_state_id, collapsed: true}});
      } else if (region.kind === 'fold') walk(region.children);
      else for (let line = region.start.line; line < end; line++) {
        const text = lines[line] ?? '';
        output.push({key: `line:${region.alignment_id}:${line - region.start.line}`, line: line + 1, text,
          changed: (region.changed ?? []).some(span => span.line === line),
          highlights: (region.search_highlights ?? []).filter(span => span.line === line).map(span => ({startColumn: column(text, span.start_column), endColumn: column(text, span.end_column)}))});
      }
      if (output[first] && !output[first].fold && (region.kind === 'fold' || region.visibility?.label))
        output[first].fold = {id: region.fold_state_id, collapsed: false};
    }
  };
  walk(source.regions);
  return output;
}

/** Use supplied structural alignment, visibility and highlights; never compute a new diff. */
export function evidenceRows(result: SearchResultData): EvidenceRow[] {
  const lhs = result.sources.lhs ? items(result.sources.lhs) : [];
  const rhs = result.sources.rhs ? items(result.sources.rhs) : [];
  const rows: EvidenceRow[] = [];
  const append = (left?: Item, right?: Item) => {
    if (left && right && (left.changed || right.changed || left.text !== right.text) && !left.fold?.collapsed && !right.fold?.collapsed) {
      append(left); append(undefined, right); return;
    }
    const item = right ?? left!;
    rows.push({lineNumber: rows.length + 1, content: item.text,
      kind: item.changed ? right ? 'added' : 'deleted' : 'unchanged',
      baseLine: left?.line, headLine: right?.line,
      authorSide: right ? 'head' : 'base', authorLine: item.line,
      highlights: [...(left?.highlights ?? []), ...(right?.highlights ?? [])], fold: item.fold ?? left?.fold});
  };
  let right = 0;
  for (const left of lhs) {
    const match = rhs.findIndex((item, index) => index >= right && item.key === left.key);
    if (match < 0) append(left);
    else {
      while (right < match) append(undefined, rhs[right++]);
      append(left, rhs[right++]);
    }
  }
  while (right < rhs.length) append(undefined, rhs[right++]);
  return rows;
}

export function evidenceCoordinates(content: ReviewInlineEditorSpec['content']) {
  if (content.kind === 'source') return content;
  const result = content.result;
  const side = result.sources.rhs ? 'head' as const : 'base' as const;
  const file = result.file.rhs ?? result.file.lhs!;
  const source = result.sources.rhs ?? result.sources.lhs!;
  return {path: file.path, side, ranges: source.regions.map(region => ({startLine: region.start.line + 1, endLine: Math.max(region.start.line + 1, region.end.line + Number(region.end.column > 0))}))};
}
