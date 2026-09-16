import type { ReviewElementProps, ReviewNode } from "../review-document-data";

interface Source {
  side: "base" | "head";
  file: string;
  fromLine: number;
  toLine: number;
}

type ElementNode = Extract<ReviewNode, { type: "element" }>;

/** The link form `sourceReferences` in review-api/document.ts accepts. */
export function sourceLink(source: Source): string {
  const file = source.file.split("/").map(encodeURIComponent).join("/");

  return `review-source:${source.side}/${file}#L${source.fromLine}-L${source.toLine}`;
}

/** Prose is text, HTML-ish elements, and the one inline component. */
export function isProseNode(node: ReviewNode): boolean {
  return (
    node.type === "text" ||
    node.type === "element" ||
    (node.type === "component" && node.name === "AnchorLink")
  );
}

const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "pre",
  "blockquote",
  "hr",
  "table",
  "section",
  "thead",
  "tbody",
  "tr",
]);

function alignRow(align: ReviewElementProps[string] | undefined): string {
  switch (align) {
    case "left":
      return ":--";
    case "center":
      return ":-:";
    case "right":
      return "--:";
    default:
      return "---";
  }
}

/** Sealed review prose (a `review-document/1` element tree) as GFM Markdown
 * that `parseMarkdown` reads back. Footnote definitions collect at the end. */
export function proseToMarkdown(nodes: ReviewNode[]): string {
  const footnotes: string[] = [];
  const body = blocks(nodes, footnotes).trimEnd();

  return `${[body, ...footnotes].filter(Boolean).join("\n\n")}\n`;
}

function blocks(nodes: ReviewNode[], footnotes: string[], indent = ""): string {
  const out: string[] = [];
  let inline: ReviewNode[] = [];

  const flush = () => {
    if (inline.length === 0) return;
    const text = inlines(inline).trim();

    if (text) out.push(indent + text);
    inline = [];
  };

  for (const node of nodes) {
    if (node.type === "element" && BLOCK_TAGS.has(node.tag)) {
      flush();
      const rendered = block(node, footnotes, indent);

      if (rendered) out.push(rendered);
    } else inline.push(node);
  }

  flush();

  return out.join("\n\n");
}

function block(node: ElementNode, footnotes: string[], indent: string): string {
  const { tag, children, props } = node;

  switch (tag) {
    case "p":
      return indent + inlines(children).trim();
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${indent}${"#".repeat(Number(tag[1]))} ${inlines(children).trim()}`;
    case "hr":
      return `${indent}---`;
    case "blockquote":
      return blocks(children, footnotes)
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
    case "pre":
      return fencedCode(node, indent);
    case "ul":
    case "ol":
      return children
        .filter(
          (child): child is ElementNode =>
            child.type === "element" && child.tag === "li",
        )
        .map((li) =>
          listItem(li, tag === "ol" ? "1. " : "- ", footnotes, indent),
        )
        .join("\n");
    case "table":
      return table(node, indent);
    case "section":
      if (props["data-footnotes"]) {
        collectFootnotes(node, footnotes);

        return "";
      }

      return blocks(children, footnotes, indent);
    default:
      return blocks(children, footnotes, indent);
  }
}

function fencedCode(node: ElementNode, indent: string): string {
  const code = node.children.find(
    (child): child is ElementNode =>
      child.type === "element" && child.tag === "code",
  );

  const source = plainText(code ? code.children : node.children);

  const language = code
    ? (/language-([\w-]+)/.exec(String(code.props.className ?? ""))?.[1] ?? "")
    : "";

  const fence = "`".repeat(Math.max(3, longestRun(source, "`") + 1));

  return [
    `${indent}${fence}${language}`,
    ...source
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => indent + line),
    `${indent}${fence}`,
  ].join("\n");
}

function listItem(
  li: ElementNode,
  marker: string,
  footnotes: string[],
  indent: string,
): string {
  let prefix = marker;
  let children = li.children;
  const first = children[0];

  if (first?.type === "element" && first.tag === "input") {
    prefix = `${marker}[${first.props.checked ? "x" : " "}] `;
    children = children.slice(1);
  }

  const inner = blocks(children, footnotes, indent + " ".repeat(marker.length));
  const [head = "", ...rest] = inner.split("\n");

  return [
    indent + prefix + head.trimStart(),
    ...rest.filter((line) => line.trim() !== ""),
  ].join("\n");
}

function table(node: ElementNode, indent: string): string {
  const rows: ElementNode[] = [];

  for (const part of node.children)
    if (part.type === "element")
      for (const row of part.tag === "tr" ? [part] : part.children)
        if (row.type === "element" && row.tag === "tr") rows.push(row);

  const cells = (row: ElementNode) =>
    row.children.filter(
      (child): child is ElementNode =>
        child.type === "element" && (child.tag === "th" || child.tag === "td"),
    );

  const render = (row: ElementNode) =>
    `${indent}| ${cells(row)
      .map((cell) => inlines(cell.children).trim().replaceAll("|", "\\|"))
      .join(" | ")} |`;

  const [header, ...body] = rows;

  if (!header) return "";

  const align = cells(header).map((cell) => alignRow(cell.props.align));

  return [
    render(header),
    `${indent}| ${align.join(" | ")} |`,
    ...body.map(render),
  ].join("\n");
}

function collectFootnotes(section: ElementNode, footnotes: string[]): void {
  for (const list of section.children)
    if (list.type === "element" && list.tag === "ol")
      for (const li of list.children)
        if (li.type === "element" && li.tag === "li") {
          const n =
            /(\d+)$/.exec(String(li.props.id ?? ""))?.[1] ??
            String(footnotes.length + 1);

          footnotes.push(
            `[^${n}]: ${blocks(stripBackrefs(li.children), []).trim()}`,
          );
        }
}

function stripBackrefs(nodes: ReviewNode[]): ReviewNode[] {
  return nodes.flatMap((node): ReviewNode[] => {
    if (node.type !== "element") return [node];

    if (node.props["data-footnote-backref"]) return [];

    return [{ ...node, children: stripBackrefs(node.children) }];
  });
}

function inlines(nodes: ReviewNode[]): string {
  return nodes.map(inline).join("");
}

function inline(node: ReviewNode): string {
  if (node.type === "text") return escapeText(node.value);

  if (node.type === "component") {
    // SAFETY: reviewDocumentDataSchema validated AnchorLink props against
    // reviewComponentDataSchemas.AnchorLink when the sealed document was parsed.
    const anchor = (
      node.props as { anchor?: { title?: string; peek?: Source } }
    ).anchor;

    const label = inlines(node.children) || anchor?.title || "";

    return node.name === "AnchorLink" && anchor?.peek
      ? `[${label}](${sourceLink(anchor.peek)})`
      : label;
  }

  const { tag, children, props } = node;

  switch (tag) {
    case "strong":
    case "b":
      return `**${inlines(children)}**`;
    case "em":
    case "i":
      return `*${inlines(children)}*`;
    case "del":
    case "s":
      return `~~${inlines(children)}~~`;
    case "code":
    case "kbd": {
      const text = plainText(children);
      const ticks = "`".repeat(longestRun(text, "`") + 1);

      return `${ticks}${text}${ticks}`;
    }

    case "a":
      if (props["data-footnote-ref"])
        return `[^${/(\d+)$/.exec(String(props.href ?? ""))?.[1] ?? "1"}]`;

      if (props["data-footnote-backref"]) return "";

      return `[${inlines(children)}](${String(props.href ?? "")})`;
    case "img":
      return `![${String(props.alt ?? "")}](${String(props.src ?? "")})`;
    case "br":
      return "  \n";
    case "input":
      return "";
    default:
      return BLOCK_TAGS.has(tag) ? blocks([node], []) : inlines(children);
  }
}

function plainText(nodes: ReviewNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text" ? node.value : plainText(node.children),
    )
    .join("");
}

function longestRun(text: string, ch: string): number {
  return Math.max(
    0,
    ...(text.match(new RegExp(`${ch}+`, "g")) ?? []).map((run) => run.length),
  );
}

function escapeText(value: string): string {
  return value
    .replace(/([\\`*_[\]<>])/g, "\\$1")
    .replace(/^(\s*)(\d+)\./gm, "$1$2\\.")
    .replace(/^(\s*)([#+-])/gm, "$1\\$2");
}
