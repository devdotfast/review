import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

import { latexMath, latexMathFromMarkdown } from "./markdown-latex-math";

export interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  url?: string;
  title?: string | null;
  align?: Array<string | null> | null;
  alt?: string | null;
  identifier?: string;
  label?: string | null;
}

export function* markdownNodes(node: MarkdownNode): Generator<MarkdownNode> {
  yield node;

  for (const child of node.children ?? []) yield* markdownNodes(child);
}

/** The text a node carries, its own and every descendant's. */
export function markdownText(node: MarkdownNode): string {
  return [...markdownNodes(node)].map((child) => child.value ?? "").join("");
}

/** Shared syntax for submit-time source checks and safe Markdown rendering. */
export function parseMarkdown(source: string): MarkdownNode {
  const tree: MarkdownNode = fromMarkdown(source, {
    extensions: [gfm(), math(), latexMath()],
    mdastExtensions: [
      gfmFromMarkdown(),
      mathFromMarkdown(),
      latexMathFromMarkdown(),
    ],
  });

  const definitions = new Map<string, MarkdownNode>();

  for (const node of markdownNodes(tree))
    if (node.type === "definition" && !definitions.has(node.identifier!))
      definitions.set(node.identifier!, node);

  for (const node of markdownNodes(tree)) {
    if (node.type !== "linkReference") continue;
    const definition = definitions.get(node.identifier!);

    if (definition)
      Object.assign(node, {
        type: "link",
        url: definition.url,
        title: definition.title,
      });
  }

  return tree;
}
