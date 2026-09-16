import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface MarkdownNode {
  type: string;
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

/** Shared syntax for submit-time source checks and safe Markdown rendering. */
export function parseMarkdown(source: string): MarkdownNode {
  const tree: MarkdownNode = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
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
