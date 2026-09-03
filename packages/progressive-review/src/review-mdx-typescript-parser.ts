import type { ParserOptions } from "@babel/parser";
import { parse, parseExpression } from "@babel/parser";
import type { Comment, Expression, Program } from "estree";

import { hasEstreeOffsets, walkEstree } from "./review-mdx-ast";

/**
 * What `@babel/parser` returns under the "estree" plugin. Its typings describe
 * the Babel AST, but the plugin rewrites nodes and comments into ESTree form.
 */
interface EstreeParseResult {
  program: Program;
  comments: Comment[] | null;
}

/**
 * The fields micromark reads off a failed parse, matching acorn's SyntaxError:
 * Babel records the offset as `pos`; acorn callers expect `raisedAt`.
 */
interface AcornCompatibleError extends Error {
  pos?: number;
  raisedAt?: number;
}

const parserOptions = {
  sourceType: "module",
  plugins: ["estree", "typescript", "jsx"],
  ranges: true,
  attachComment: true,
} satisfies ParserOptions;

/** Acorn-compatible syntax adapter used by MDX's micromark extensions. */
export const reviewTypescriptEstreeParser = {
  parse(
    value: string,
    options?: { sourceType?: "script" | "module" },
  ): Program {
    return withAcornCompatibleError(() => {
      // SAFETY: parserOptions enables the "estree" plugin, so the returned
      // program and comments are ESTree nodes despite Babel's declared types.
      const file = parse(value, {
        ...parserOptions,
        sourceType: options?.sourceType ?? "module",
      }) as EstreeParseResult;
      const program = file.program;
      program.comments = file.comments ?? [];
      return program;
    });
  },
  parseExpressionAt(value: string, offset: number): Expression {
    return withAcornCompatibleError(() => {
      // SAFETY: parserOptions enables the "estree" plugin, so the returned
      // expression is an ESTree node despite Babel's declared type.
      const expression = parseExpression(
        value.slice(offset),
        parserOptions,
      ) as Expression;
      if (offset > 0) offsetEstreeNode(expression, offset);
      return expression;
    });
  },
};

function withAcornCompatibleError<T>(run: () => T): T {
  try {
    return run();
  } catch (cause) {
    if (cause instanceof Error) {
      const syntaxError: AcornCompatibleError = cause;
      syntaxError.raisedAt = (syntaxError.pos ?? 0) + 1;
    }
    throw cause;
  }
}

function offsetEstreeNode(root: Expression, offset: number): void {
  walkEstree(root, (node) => {
    if (hasEstreeOffsets(node)) {
      node.start += offset;
      node.end += offset;
    }
    if (node.range) {
      node.range = [node.range[0] + offset, node.range[1] + offset];
    }
  });
}
