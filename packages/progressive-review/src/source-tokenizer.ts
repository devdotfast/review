import type { SourceToken, SourceTokenKind } from "./source-code-types";

/** Tokenize one source line for the lightweight source preview. */
export function tokenizeSourceLine(source: string): SourceToken[] {
  if (!source) return [];
  const tokens: SourceToken[] = [];
  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    const match =
      rest.match(/^\s+/) ??
      rest.match(/^\/\/.*/) ??
      rest.match(/^\/\*.*?(?:\*\/|$)/) ??
      rest.match(/^(['"`])(?:\\.|(?!\1).)*\1?/) ??
      rest.match(/^\d+(?:\.\d+)?n?/) ??
      rest.match(/^[A-Za-z_$][\w$]*/) ??
      rest.match(/^[{}()[\].,;:?~!%^&*+\-=|/<>]+/) ??
      rest.match(/^./);
    const text = match?.[0] ?? rest[0];
    tokens.push({ t: text, k: classifySourceToken(text) });
    index += text.length;
  }

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    if (tokens[tokenIndex].k !== "id") continue;
    for (
      let nextIndex = tokenIndex + 1;
      nextIndex < tokens.length;
      nextIndex += 1
    ) {
      if (tokens[nextIndex].k === "w") continue;
      if (tokens[nextIndex].t === "(") {
        tokens[tokenIndex] = { ...tokens[tokenIndex], k: "fn" };
      }
      break;
    }
  }

  return tokens;
}

const SOURCE_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "return",
  "satisfies",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

function classifySourceToken(text: string): SourceTokenKind {
  if (/^\s+$/.test(text)) return "w";
  if (text.startsWith("//") || text.startsWith("/*")) return "com";
  if (/^['"`]/.test(text)) return "str";
  if (/^\d/.test(text)) return "num";
  if (/^[A-Za-z_$]/.test(text)) {
    return SOURCE_KEYWORDS.has(text) ? "kw" : "id";
  }
  if (/^[{}()[\].,;:?~!%^&*+\-=|/<>]+$/.test(text)) return "op";
  return "t";
}
