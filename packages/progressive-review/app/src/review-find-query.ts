import type { ReviewFindQuery } from "@dev.fast/review-protocol";

export interface CompiledReviewFindQuery {
  expression: RegExp;
}

export function compileReviewFindQuery(
  query: ReviewFindQuery,
): CompiledReviewFindQuery | { error: string } {
  if (!query.text) return { expression: /(?:)/g };
  const source = query.isRegex
    ? query.text
    : escapeRegularExpression(query.text);
  const bounded = query.wholeWord ? `\\b(?:${source})\\b` : source;
  try {
    return {
      expression: new RegExp(bounded, query.matchCase ? "gu" : "giu"),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function regularExpressionMatches(
  text: string,
  expression: RegExp,
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  expression.lastIndex = 0;
  for (;;) {
    const match = expression.exec(text);
    if (!match) break;
    if (match[0].length === 0) {
      expression.lastIndex = advanceStringIndex(text, expression.lastIndex);
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function advanceStringIndex(value: string, index: number): number {
  if (index >= value.length) return index + 1;
  const first = value.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff || index + 1 >= value.length) {
    return index + 1;
  }
  const second = value.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}
