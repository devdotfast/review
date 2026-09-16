/** Quote matching shared by legacy publish and JSON accept: authors paste
 * transcript text with arbitrary line wrapping, so both sides compare on
 * whitespace-normalized text. */
export function normalizeQuoteText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function textIncludesQuote(text: string, quote: string): boolean {
  const normalizedQuote = normalizeQuoteText(quote);

  return (
    normalizedQuote !== "" && normalizeQuoteText(text).includes(normalizedQuote)
  );
}
