import { isNumberValue, isStringValue } from "@dev.fast/review-protocol";
// Deliberately separate from the MDX document pipeline: this renderer walks the
// mdast of untrusted runtime strings (agent/thread message bodies) and never
// evaluates them, whereas MDX compilation produces executable code and must
// only ever see trusted authored review documents.
import {
  type ComponentType,
  Fragment,
  type ReactElement,
  type ReactNode,
  createContext,
  createElement,
  useContext,
} from "react";

import { type MarkdownNode, parseMarkdown } from "../../src/markdown";
import { RenderedCodeBlock } from "./code-block";
import { HighlightedText } from "./highlighted-text";
import { newTabLinkProps } from "./link-props";

type LinkRenderer = (href: string, children: ReactNode) => ReactNode;

const DocumentLink = createContext<LinkRenderer | undefined>(undefined);

export function AgentMarkdown({
  source,
  className,
  highlightQuote,
}: {
  source: string;
  className?: string;
  highlightQuote?: string;
}): ReactElement {
  const tree = parseMarkdown(source);

  return (
    <div className={["agent-markdown", className].filter(Boolean).join(" ")}>
      {renderMarkdownChildren(tree.children ?? [], "root", highlightQuote)}
    </div>
  );
}

/** Reuse safe Markdown parsing in documents without the chat-message wrapper. */
export function MarkdownContent({
  source,
  h1: Heading,
  renderLink,
}: {
  source: string;
  h1?: ComponentType<{ children?: ReactNode }>;
  renderLink?: LinkRenderer;
}): ReactElement {
  return (
    <DocumentLink.Provider value={renderLink}>
      {(parseMarkdown(source).children ?? []).map((node, index) =>
        node.type === "heading" && node.depth === 1 && Heading ? (
          <Heading key={index}>
            {renderMarkdownChildren(node.children ?? [], String(index))}
          </Heading>
        ) : (
          renderMarkdownNode(node, String(index))
        ),
      )}
    </DocumentLink.Provider>
  );
}

export const markdownHasTitle = (source: string) =>
  (parseMarkdown(source).children ?? []).some(
    (node) => node.type === "heading" && node.depth === 1,
  );

/**
 * Plain-text excerpt of a markdown message for clamped previews (Notion-style):
 * formatting is dropped and only text content kept, so a preview never shows
 * raw `**` syntax nor fights a line clamp with block layout and code chips.
 */
export function markdownExcerpt(source: string): string {
  const tree = parseMarkdown(source);
  const parts: string[] = [];

  const walk = (node: MarkdownNode) => {
    if (
      node.type === "text" ||
      node.type === "inlineCode" ||
      node.type === "code"
    ) {
      if (node.value) parts.push(node.value);

      return;
    }

    node.children?.forEach(walk);
  };

  walk(tree);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function renderMarkdownChildren(
  children: MarkdownNode[],
  keyPrefix: string,
  highlightQuote?: string,
): ReactNode {
  return children.map((child, index) =>
    renderMarkdownNode(child, `${keyPrefix}:${index}`, highlightQuote),
  );
}

function renderMarkdownNode(
  node: MarkdownNode,
  key: string,
  highlightQuote?: string,
): ReactNode {
  switch (node.type) {
    case "root":
      return (
        <Fragment key={key}>
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </Fragment>
      );
    case "paragraph":
      return (
        <p key={key}>
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </p>
      );
    case "text":
      if (highlightQuote) {
        return (
          <HighlightedText
            key={key}
            text={node.value ?? ""}
            quote={highlightQuote}
          />
        );
      }

      return node.value ?? "";
    case "emphasis":
      return (
        <em key={key}>
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </em>
      );
    case "strong":
      return (
        <strong key={key}>
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </strong>
      );
    case "delete":
      return (
        <del key={key}>
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </del>
      );
    case "inlineCode":
      if (highlightQuote) {
        return (
          <code key={key}>
            <HighlightedText text={node.value ?? ""} quote={highlightQuote} />
          </code>
        );
      }

      return <code key={key}>{node.value ?? ""}</code>;
    case "code":
      return (
        <RenderedCodeBlock
          key={key}
          className="markdown-code-block"
          code={node.value ?? ""}
          language={node.lang}
        />
      );
    case "break":
      return <br key={key} />;
    case "thematicBreak":
      return <hr key={key} />;
    case "heading":
      return createElement(
        headingTag(node.depth),
        { key },
        renderMarkdownChildren(node.children ?? [], key, highlightQuote),
      );
    case "blockquote":
      return (
        <blockquote key={key}>
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </blockquote>
      );
    case "list": {
      const Tag = node.ordered ? "ol" : "ul";

      return createElement(
        Tag,
        { key, start: node.ordered ? (node.start ?? undefined) : undefined },
        renderMarkdownChildren(node.children ?? [], key, highlightQuote),
      );
    }

    case "listItem":
      return (
        <li key={key}>
          {node.checked !== null && node.checked !== undefined && (
            <input type="checkbox" checked={node.checked} readOnly />
          )}
          {renderMarkdownChildren(node.children ?? [], key, highlightQuote)}
        </li>
      );
    case "link": {
      const children = renderMarkdownChildren(
        node.children ?? [],
        key,
        highlightQuote,
      );

      return (
        <MarkdownLink
          key={key}
          href={node.url ?? ""}
          title={node.title ?? undefined}
        >
          {children}
        </MarkdownLink>
      );
    }

    case "image":
      return node.alt ? <em key={key}>{node.alt}</em> : null;
    case "table":
      return renderTable(node, key);
    case "tableRow":
      return (
        <tr key={key}>{renderMarkdownChildren(node.children ?? [], key)}</tr>
      );
    case "tableCell":
      return (
        <td key={key}>{renderMarkdownChildren(node.children ?? [], key)}</td>
      );
    case "html":
      return node.value ?? "";
    default:
      return node.children
        ? renderMarkdownChildren(node.children, key)
        : (node.value ?? null);
  }
}

function headingTag(depth: number | undefined): "h1" | "h2" | "h3" | "h4" {
  if (depth === 1) return "h1";

  if (depth === 2) return "h2";

  if (depth === 3) return "h3";

  return "h4";
}

function renderTable(node: MarkdownNode, key: string): ReactElement {
  const rows = node.children ?? [];
  const [header, ...body] = rows;

  return (
    <table key={key}>
      {header && <thead>{renderTableRow(header, `${key}:head`, true)}</thead>}
      <tbody>
        {body.map((row, index) =>
          renderTableRow(row, `${key}:body:${index}`, false),
        )}
      </tbody>
    </table>
  );
}

function renderTableRow(
  node: MarkdownNode,
  key: string,
  isHeader: boolean,
): ReactElement {
  const Cell = isHeader ? "th" : "td";

  return (
    <tr key={key}>
      {(node.children ?? []).map((cell, index) =>
        createElement(
          Cell,
          { key: `${key}:cell:${index}` },
          renderMarkdownChildren(cell.children ?? [], `${key}:cell:${index}`),
        ),
      )}
    </tr>
  );
}

function MarkdownLink({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title?: string;
}): ReactElement {
  const renderLink = useContext(DocumentLink);
  const custom = renderLink?.(href, children);

  if (custom !== undefined) return <>{custom}</>;

  if (isLocalFilesystemHref(href))
    return (
      <code className="agent-markdown-code-reference">
        {textFromChildren(children) ?? "local file"}
      </code>
    );

  if (!safeMarkdownHref(href)) return <span>{children}</span>;
  const linkProps = newTabLinkProps(href);

  return (
    <a href={href} title={title} {...linkProps}>
      {children}
    </a>
  );
}

function safeMarkdownHref(value: string | undefined): string | null {
  if (!value) return null;

  if (value.startsWith("#")) return value;

  if (isLocalFilesystemHref(value)) return null;

  try {
    const url = new URL(value, "http://localhost");

    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function isLocalFilesystemHref(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();

  if (/^file:/i.test(trimmed)) return true;

  if (/^[a-z]:[\\/]/i.test(trimmed)) return true;

  return /^\/(?:Users|home|tmp|var|private|Volumes|mnt|workspace)\//.test(
    trimmed,
  );
}

/** A React child that renders as its own text: a string or a number. */
export function isReactTextNode(node: ReactNode): node is string | number {
  return isStringValue(node) || isNumberValue(node);
}

function textFromChildren(children: ReactNode): string | null {
  if (isReactTextNode(children)) return String(children);

  if (Array.isArray(children)) {
    const text = children
      .map((child) => textFromChildren(child) ?? "")
      .join("")
      .trim();

    return text || null;
  }

  return null;
}
