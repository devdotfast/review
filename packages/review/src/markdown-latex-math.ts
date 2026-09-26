import type {
  Extension as FromMarkdownExtension,
  Handle,
} from "mdast-util-from-markdown";
import type {
  Code,
  Construct,
  Extension,
  State,
  TokenizeContext,
} from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    latexInlineMath: "latexInlineMath";
    latexDisplayMath: "latexDisplayMath";
    latexMathSequence: "latexMathSequence";
    latexMathData: "latexMathData";
  }
}

const backslash = 92;

/**
 * LaTeX's own math delimiters: `\(…\)` inline and `\[…\]` display.
 * CommonMark would read `\(` as an escaped parenthesis, so these constructs
 * run before character escapes; an unclosed opener still falls back to one.
 * `\[` and `\]` count only on lines of their own, because escaped brackets in
 * prose (`\[1\]`, as `escapeMarkdownText` writes them) must stay brackets.
 */
export function latexMath(): Extension {
  return {
    text: {
      [backslash]: [
        delimitedMath("latexInlineMath", 40, 41, false),
        delimitedMath("latexDisplayMath", 91, 93, true),
      ],
    },
  };
}

/** Builds `inlineMath` and `math` nodes, the ones `$` and `$$` produce. */
export function latexMathFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      latexInlineMath(token) {
        this.enter({ type: "inlineMath", value: "" }, token);
        this.buffer();
      },
      latexDisplayMath(token) {
        this.enter({ type: "math", value: "" }, token);
        this.buffer();
      },
    },
    exit: {
      latexInlineMath: exitMath,
      latexDisplayMath: exitMath,
      latexMathData(token) {
        this.config.enter.data.call(this, token);
        this.config.exit.data.call(this, token);
      },
    },
  };
}

const exitMath: Handle = function (token) {
  const value = this.resume().trim();
  const node = this.stack.at(-1);

  if (node?.type !== "inlineMath" && node?.type !== "math")
    throw new Error(`Expected a math node, found ${node?.type}.`);
  node.value = value;
  this.exit(token);
};

const lineEnding = (code: Code) => code !== null && code < -2;

// Space, and the tab and virtual-space codes micromark splits tabs into.
const lineSpace = (code: Code) => code === 32 || code === -2 || code === -1;

function delimitedMath(
  type: "latexInlineMath" | "latexDisplayMath",
  open: number,
  close: number,
  ownLine: boolean,
): Construct {
  const closing: Construct = { tokenize: tokenizeClosing, partial: true };

  return { name: type, tokenize: tokenizeMath };

  function tokenizeMath(
    this: TokenizeContext,
    effects: Parameters<Construct["tokenize"]>[0],
    ok: State,
    nok: State,
  ): State {
    let lineStart = false;

    return start;

    function start(code: Code): State | undefined {
      effects.enter(type);
      effects.enter("latexMathSequence");
      effects.consume(code);

      return opening;
    }

    function opening(code: Code): State | undefined {
      if (code !== open) return nok(code);
      effects.consume(code);

      return ownLine ? openingLine : openingEnd;
    }

    function openingLine(code: Code): State | undefined {
      if (lineSpace(code)) {
        effects.consume(code);

        return openingLine;
      }

      return lineEnding(code) ? openingEnd(code) : nok(code);
    }

    function openingEnd(code: Code): State | undefined {
      effects.exit("latexMathSequence");

      return between(code);
    }

    function between(code: Code): State | undefined {
      if (code === null) return nok(code);

      if (code === backslash)
        return ownLine && !lineStart
          ? escape(code)
          : effects.attempt(closing, after, escape)(code);

      if (lineEnding(code)) {
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        lineStart = true;

        return between;
      }

      effects.enter("latexMathData");

      return data(code);
    }

    // A TeX control sequence such as `\\` or `\{` stays one unit, so the
    // `)` in `\\)` never closes.
    function escape(code: Code): State | undefined {
      effects.enter("latexMathData");
      effects.consume(code);
      lineStart = false;

      return escaped;
    }

    function escaped(code: Code): State | undefined {
      if (code === null || lineEnding(code)) {
        effects.exit("latexMathData");

        return between(code);
      }

      effects.consume(code);

      return data;
    }

    function data(code: Code): State | undefined {
      if (code === null || code === backslash || lineEnding(code)) {
        effects.exit("latexMathData");

        return between(code);
      }

      if (!lineSpace(code)) lineStart = false;
      effects.consume(code);

      return data;
    }

    function after(code: Code): State | undefined {
      effects.exit(type);

      return ok(code);
    }
  }

  function tokenizeClosing(
    this: TokenizeContext,
    effects: Parameters<Construct["tokenize"]>[0],
    ok: State,
    nok: State,
  ): State {
    return start;

    function start(code: Code): State | undefined {
      effects.enter("latexMathSequence");
      effects.consume(code);

      return closer;
    }

    function closer(code: Code): State | undefined {
      if (code !== close) return nok(code);
      effects.consume(code);

      return ownLine ? closingLine : closingEnd;
    }

    function closingLine(code: Code): State | undefined {
      if (lineSpace(code)) {
        effects.consume(code);

        return closingLine;
      }

      return code === null || lineEnding(code) ? closingEnd(code) : nok(code);
    }

    function closingEnd(code: Code): State | undefined {
      effects.exit("latexMathSequence");

      return ok(code);
    }
  }
}
