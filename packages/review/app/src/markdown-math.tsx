import type {
  LiteElement,
  LiteNode,
} from "mathjax-full/js/adaptors/lite/Element.js";
import { LiteText } from "mathjax-full/js/adaptors/lite/Text.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "mathjax-full/js/input/tex/braket/BraketConfiguration.js";
import "mathjax-full/js/input/tex/cancel/CancelConfiguration.js";
import "mathjax-full/js/input/tex/cases/CasesConfiguration.js";
import "mathjax-full/js/input/tex/color/ColorConfiguration.js";
import "mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";
import "mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  createElement,
  useMemo,
} from "react";

// TeX here is untrusted runtime text, so the packages that emit arbitrary
// styles, classes or links (html, bbox, action) and the ones that fetch code
// (require, autoload) stay out.
const TEX_PACKAGES = [
  "base",
  "ams",
  "boldsymbol",
  "braket",
  "cancel",
  "cases",
  "color",
  "mathtools",
  "newcommand",
  "noundefined",
  "textmacros",
];

let convert: ((tex: string, display: boolean) => LiteElement) | undefined;

function texToSvg(tex: string, display: boolean): LiteElement {
  if (!convert) {
    RegisterHTMLHandler(liteAdaptor());

    // Glyphs are inline paths: the workbench CSP admits no font files, and a
    // shared glyph cache would tie each equation to ids defined elsewhere.
    const document = mathjax.document("", {
      InputJax: new TeX({ packages: TEX_PACKAGES }),
      OutputJax: new SVG({ fontCache: "none" }),
    });

    convert = (source, isDisplay) => {
      const container: LiteElement = document.convert(source, {
        display: isDisplay,
      });

      return container;
    };
  }

  return convert(tex, display);
}

/** TeX math typeset by MathJax as inline SVG, built as React elements. */
export function MarkdownMath({
  tex,
  display,
}: {
  tex: string;
  display: boolean;
}): ReactElement {
  const svg = useMemo(
    () => texToSvg(tex, display).children.map(liteToReact),
    [tex, display],
  );

  // A span even for display math, which `\[…\]` can place inside a paragraph.
  return (
    <span
      className={display ? "markdown-math-display" : "markdown-math-inline"}
      role="math"
      aria-label={tex}
    >
      {svg}
    </span>
  );
}

type ReactAttribute = [name: string, value: string | CSSProperties];

function liteToReact(node: LiteNode, key: number): ReactNode {
  if (node.kind === "#comment") return null;

  if (node instanceof LiteText) return node.value;

  const props = Object.fromEntries(
    Object.entries(node.attributes).flatMap(([name, value]) =>
      reactAttribute(name, String(value)),
    ),
  );

  return createElement(
    node.kind,
    { ...props, key },
    ...node.children.map(liteToReact),
  );
}

function reactAttribute(name: string, value: string): ReactAttribute[] {
  if (/^on/i.test(name)) return [];

  // MathJax links only to its own equation labels.
  if (name === "href" || name === "xlink:href")
    return value.startsWith("#") ? [["href", value]] : [];

  if (name === "style") return [["style", styleObject(value)]];

  if (name === "class") return [["className", value]];

  if (name.startsWith("data-") || name.startsWith("aria-"))
    return [[name, value]];

  return [[camelCase(name.replace(":", "-")), value]];
}

function styleObject(css: string): CSSProperties {
  return Object.fromEntries(
    css.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      const property = declaration.slice(0, colon).trim();

      return colon > 0 && property
        ? [[camelCase(property), declaration.slice(colon + 1).trim()]]
        : [];
    }),
  );
}

const camelCase = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
