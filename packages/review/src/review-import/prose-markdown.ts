import type {
  ReviewComponentNode,
  ReviewElementProps,
  ReviewNode,
} from "../review-document-data";

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

/** Footnote definitions by label. Markdown blocks parse independently, so a
 * block must carry the definitions of the footnotes it references. */
export type FootnoteDefinitions = Map<string, string>;

/** Renders a component the caller carries itself, such as one it turns into a
 * block of its own; `undefined` falls back to the Markdown rendering. */
export type RenderProseNode = (node: ReviewComponentNode) => string | undefined;

interface FootnoteState {
  definitions: FootnoteDefinitions;
  referenced: Set<string>;
  /** Components found inside prose that Markdown cannot carry. */
  warnings?: string[];
  render?: RenderProseNode;
}

/** Every footnote definition in a document, from any `section[data-footnotes]`. */
export function collectFootnoteDefinitions(
  nodes: ReviewNode[],
  warnings?: string[],
  render?: RenderProseNode,
): FootnoteDefinitions {
  const state: FootnoteState = {
    definitions: new Map(),
    referenced: new Set(),
    warnings,
    render,
  };

  const visit = (node: ReviewNode) => {
    if (node.type === "element" && isFootnoteSection(node))
      collectFootnotes(node, state);
    else if (node.type !== "text") node.children.forEach(visit);
  };

  nodes.forEach(visit);

  return state.definitions;
}

/** Sealed review prose (a `review-document/1` element tree) as GFM Markdown
 * that `parseMarkdown` reads back. Definitions of the footnotes referenced in
 * `nodes` are appended, taken from `footnotes` when given, else from the
 * footnote section inside `nodes`. */
export function proseToMarkdown(
  nodes: ReviewNode[],
  footnotes?: FootnoteDefinitions,
  warnings?: string[],
  render?: RenderProseNode,
): string {
  const state: FootnoteState = {
    definitions:
      footnotes ?? collectFootnoteDefinitions(nodes, warnings, render),
    referenced: new Set(),
    warnings,
    render,
  };

  const body = blocks(nodes, state).trimEnd();

  const definitions = [...state.referenced].flatMap((label) => {
    const text = state.definitions.get(label);

    return text === undefined ? [] : [`[^${label}]: ${text}`];
  });

  return `${[body, ...definitions].filter(Boolean).join("\n\n")}\n`;
}

/** The `section[data-footnotes]` the Markdown pipeline appends to a document. */
export function isFootnoteSection(node: ReviewNode): boolean {
  return node.type === "element" && "data-footnotes" in node.props;
}

/** Footnote labels come from `#user-content-fn-<label>` (refs) and
 * `user-content-fn-<label>` (definitions), falling back to trailing digits. */
function footnoteLabel(value: string): string | null {
  return (
    /user-content-fn(?:ref)?-(.+)$/.exec(value)?.[1] ??
    /(\d+)$/.exec(value)?.[1] ??
    null
  );
}

function blocks(
  nodes: ReviewNode[],
  state: FootnoteState,
  indent = "",
  separator = "\n\n",
): string {
  const out: string[] = [];
  let inline: ReviewNode[] = [];

  const flush = () => {
    if (inline.length === 0) return;
    const text = inlines(inline, state).trim();

    if (text) out.push(indent + text);
    inline = [];
  };

  for (const node of nodes) {
    if (node.type === "element" && BLOCK_TAGS.has(node.tag)) {
      flush();
      const rendered = block(node, state, indent);

      if (rendered) out.push(rendered);
    } else inline.push(node);
  }

  flush();

  return out.join(separator);
}

function block(
  node: ElementNode,
  state: FootnoteState,
  indent: string,
): string {
  const { tag, children, props } = node;

  switch (tag) {
    case "p":
      return indent + inlines(children, state).trim();
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${indent}${"#".repeat(Number(tag[1]))} ${inlines(children, state).trim()}`;
    case "hr":
      return `${indent}---`;
    case "blockquote":
      return blocks(children, state)
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
    case "pre":
      return fencedCode(node, indent);
    case "ul":
    case "ol": {
      const start = Number(props.start ?? 1) || 1;

      return children
        .filter(
          (child): child is ElementNode =>
            child.type === "element" && child.tag === "li",
        )
        .map((li, index) =>
          listItem(
            li,
            tag === "ol" ? `${start + index}. ` : "- ",
            state,
            indent,
          ),
        )
        .join("\n");
    }

    case "table":
      return table(node, state, indent);
    case "section":
      // Definitions are collected up front, not while rendering.
      return isFootnoteSection(node) ? "" : blocks(children, state, indent);
    default:
      return blocks(children, state, indent);
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
  state: FootnoteState,
  indent: string,
): string {
  let prefix = marker;
  let children = li.children;
  const first = children[0];

  if (first?.type === "element" && first.tag === "input") {
    prefix = `${marker}[${first.props.checked ? "x" : " "}] `;
    children = children.slice(1);
  }

  // A tight item holds bare text; a loose one wraps blocks in paragraphs.
  const loose = children.some(
    (child) => child.type === "element" && child.tag === "p",
  );

  const inner = blocks(
    children,
    state,
    indent + " ".repeat(marker.length),
    loose ? "\n\n" : "\n",
  );

  const [head = "", ...rest] = inner.split("\n");

  return [indent + prefix + head.trimStart(), ...rest].join("\n");
}

function table(
  node: ElementNode,
  state: FootnoteState,
  indent: string,
): string {
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
      .map((cell) =>
        inlines(cell.children, state).trim().replaceAll("|", "\\|"),
      )
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

function collectFootnotes(section: ElementNode, state: FootnoteState): void {
  for (const list of section.children)
    if (list.type === "element" && list.tag === "ol")
      for (const li of list.children)
        if (li.type === "element" && li.tag === "li") {
          const label =
            footnoteLabel(String(li.props.id ?? "")) ??
            String(state.definitions.size + 1);

          const inner: FootnoteState = {
            definitions: state.definitions,
            referenced: new Set(),
            warnings: state.warnings,
            render: state.render,
          };

          // Continuation lines of a definition are indented under its label.
          const definition = blocks(stripBackrefs(li.children), inner).trim();

          state.definitions.set(
            label,
            definition
              .split("\n")
              .map((line, index) =>
                index === 0 || line.trim() === "" ? line : `    ${line}`,
              )
              .join("\n"),
          );
        }
}

function stripBackrefs(nodes: ReviewNode[]): ReviewNode[] {
  return nodes.flatMap((node): ReviewNode[] => {
    if (node.type !== "element") return [node];

    if ("data-footnote-backref" in node.props) return [];

    return [{ ...node, children: stripBackrefs(node.children) }];
  });
}

function inlines(nodes: ReviewNode[], state?: FootnoteState): string {
  return nodes.map((node) => inline(node, state)).join("");
}

function inline(node: ReviewNode, state?: FootnoteState): string {
  if (node.type === "text") return escapeMarkdownText(node.value);

  if (node.type === "component") return inlineComponent(node, state);

  const { tag, children, props } = node;

  switch (tag) {
    case "strong":
    case "b":
      return `**${inlines(children, state)}**`;
    case "em":
    case "i":
      return `*${inlines(children, state)}*`;
    case "del":
    case "s":
      return `~~${inlines(children, state)}~~`;
    case "code":
    case "kbd": {
      const text = plainText(children);
      const ticks = "`".repeat(longestRun(text, "`") + 1);
      // A span that starts or ends with a backtick needs padding spaces.
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";

      return `${ticks}${pad}${text}${pad}${ticks}`;
    }

    case "a":
      if ("data-footnote-ref" in props) {
        const label = footnoteLabel(String(props.href ?? "")) ?? "1";
        state?.referenced.add(label);

        return `[^${label}]`;
      }

      if ("data-footnote-backref" in props) return "";

      return `[${inlines(children, state)}](${String(props.href ?? "")})`;
    case "img":
      return `![${String(props.alt ?? "")}](${String(props.src ?? "")})`;
    case "br":
      return "  \n";
    case "input":
      return "";
    default:
      return BLOCK_TAGS.has(tag)
        ? blocks(
            [node],
            state ?? { definitions: new Map(), referenced: new Set() },
          )
        : inlines(children, state);
  }
}

/** Only `AnchorLink` is prose. Any other component reached here sits inside
 * an element (a peek in a list item, a quote in a paragraph): a nested
 * `CodePeek` survives as a source link, everything else keeps its text and is
 * reported so the import callout names it. */
function inlineComponent(
  node: ReviewComponentNode,
  state?: FootnoteState,
): string {
  const rendered = state?.render?.(node);

  if (rendered !== undefined) return rendered;

  // SAFETY: reviewDocumentDataSchema validated the component props against
  // reviewComponentDataSchemas when the sealed document was parsed.
  const anchor = (node.props as { anchor?: { title?: string; peek?: Source } })
    .anchor;

  const text = inlines(node.children, state);

  if (node.name === "AnchorLink")
    return anchor?.peek
      ? `[${text || anchor.title || ""}](${sourceLink(anchor.peek)})`
      : text || anchor?.title || "";

  if (node.name === "CodePeek" && anchor?.peek) {
    const peek = anchor.peek;

    const label =
      anchor.title || `${peek.file}:${peek.fromLine}-${peek.toLine}`;

    state?.warnings?.push(
      `CodePeek inside prose became a source link (${label})`,
    );

    return `[${label}](${sourceLink(peek)})`;
  }

  state?.warnings?.push(
    `${node.name} inside prose kept only its text${text ? "" : " (none)"}`,
  );

  return text;
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

/** Escape a run of text so markdown renders it verbatim. */
export function escapeMarkdownText(value: string): string {
  return value
    .replace(/([\\`*_[\]<>])/g, "\\$1")
    .replace(/^(\s*)(\d+)\./gm, "$1$2\\.")
    .replace(/^(\s*)([#+-])/gm, "$1\\$2");
}
