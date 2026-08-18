import type { ReactNode } from "react";

export function findWhitespaceNormalizedSpan(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  const trimmedQuote = quote.trim();
  if (!trimmedQuote || !text) return null;
  const normQuote = trimmedQuote.replace(/\s+/g, " ");

  let normText = "";
  const normToOriginalStart: number[] = [];
  const normToOriginalEnd: number[] = [];

  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      const spaceStart = i;
      while (i < text.length && /\s/.test(text[i])) {
        i++;
      }
      normToOriginalStart.push(spaceStart);
      normToOriginalEnd.push(i);
      normText += " ";
    } else {
      normToOriginalStart.push(i);
      normToOriginalEnd.push(i + 1);
      normText += text[i];
      i++;
    }
  }

  const matchIdx = normText.indexOf(normQuote);
  if (matchIdx === -1) {
    return null;
  }

  const origStart = normToOriginalStart[matchIdx];
  const origEnd = normToOriginalEnd[matchIdx + normQuote.length - 1];
  return { start: origStart, end: origEnd };
}

export function HighlightedText({
  text,
  quote,
}: {
  text: string;
  quote: string;
}): ReactNode {
  const span = findWhitespaceNormalizedSpan(text, quote);
  if (!span) {
    return text;
  }
  return (
    <>
      {text.slice(0, span.start)}
      <mark className="review-trace-quote-mark">
        {text.slice(span.start, span.end)}
      </mark>
      {text.slice(span.end)}
    </>
  );
}
