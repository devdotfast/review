import type { ParserOptions } from "@babel/parser";
import { parse, parseExpression } from "@babel/parser";

interface EstreeNode extends Record<string, unknown> {
  type?: string;
}

const parserOptions = {
  sourceType: "module",
  plugins: ["estree", "typescript", "jsx"],
  ranges: true,
  attachComment: true,
} satisfies ParserOptions;

/** Acorn-compatible syntax adapter used by MDX's micromark extensions. */
export const reviewTypescriptEstreeParser = {
  parse(value: string, options?: { sourceType?: "script" | "module" }) {
    return withAcornCompatibleError(() => {
      const file = parse(value, {
        ...parserOptions,
        sourceType: options?.sourceType ?? "module",
      });
      const program = file.program as unknown as EstreeNode;
      program.comments = file.comments ?? [];
      return program;
    });
  },
  parseExpressionAt(value: string, offset: number) {
    return withAcornCompatibleError(() => {
      const expression = parseExpression(
        value.slice(offset),
        parserOptions,
      ) as unknown as EstreeNode;
      if (offset > 0) offsetEstreeNode(expression, offset);
      return expression;
    });
  },
};

function withAcornCompatibleError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error && typeof error === "object") {
      const syntaxError = error as { pos?: number; raisedAt?: number };
      syntaxError.raisedAt = (syntaxError.pos ?? 0) + 1;
    }
    throw error;
  }
}

function offsetEstreeNode(value: unknown, offset: number): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) offsetEstreeNode(entry, offset);
    return;
  }
  const node = value as EstreeNode;
  if (typeof node.start === "number") node.start += offset;
  if (typeof node.end === "number") node.end += offset;
  if (
    Array.isArray(node.range) &&
    typeof node.range[0] === "number" &&
    typeof node.range[1] === "number"
  ) {
    node.range = [node.range[0] + offset, node.range[1] + offset];
  }
  for (const [property, child] of Object.entries(node)) {
    if (property === "loc" || property === "range") continue;
    offsetEstreeNode(child, offset);
  }
}
