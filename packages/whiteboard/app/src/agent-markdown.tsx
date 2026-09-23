import { isNumberValue, isStringValue } from "@dev.fast/whiteboard-protocol";
// Deliberately separate from the MDX document pipeline: this renderer walks the
// mdast of untrusted runtime strings (agent trace message bodies) and never
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

/** Whether a remote image may be fetched and shown where it was authored. */
const RemoteImages = createContext(false);

export function AgentMarkdown({
  source,
  className,
  highlightQuote,
}: {
  source: string;
  className?: string;
  highlightQuote?: string;
}): ReactElement {
  const { body, footnotes } = splitFootnotes(parseMarkdown(source));

  return (
    <div className={["agent-markdown", className].filter(Boolean).join(" ")}>
      {renderMarkdownChildren(body, "root", highlightQuote)}
      {renderFootnotes(footnotes, "root", highlightQuote)}
    </div>
  );
}

/** Reuse safe Markdown parsing in documents without the chat-message wrapper. */
export function MarkdownContent({
  source,
  h1: Heading,
  headingId,
  renderLink,
  allowRemoteImages = false,
}: {
  source: string;
  h1?: ComponentType<{ children?: ReactNode }>;
  /** The id of the document's nth h2/h3, undefined where it has none. */
  headingId?: (index: number) => string | undefined;
  renderLink?: LinkRenderer;
  allowRemoteImages?: boolean;
}): ReactElement {
  const { body, footnotes } = splitFootnotes(parseMarkdown(source));
  // Ids are addressed by ordinal among the h2/h3 alone.
  let heading = 0;

  return (
    <DocumentLink.Provider value={renderLink}>
      <RemoteImages.Provider value={allowRemoteImages}>
        {body.map((node, index) =>
          node.type === "heading" && node.depth === 1 && Heading ? (
            <Heading key={index}>
              {renderMarkdownChildren(node.children ?? [], String(index))}
            </Heading>
          ) : node.type === "heading" && headingId ? (
            createElement(
              `h${node.depth}`,
              {
                key: index,
                id:
                  node.depth === 2 || node.depth === 3
                    ? headingId(heading++)
                    : undefined,
              },
              renderMarkdownChildren(node.children ?? [], String(index)),
            )
          ) : (
            renderMarkdownNode(node, String(index))
          ),
        )}
        {renderFootnotes(footnotes, "document")}
      </RemoteImages.Provider>
    </DocumentLink.Provider>
  );
}

/** GFM footnote definitions render once, after the body, in reference order. */
function splitFootnotes(tree: MarkdownNode) {
  const body: MarkdownNode[] = [];
  const footnotes: MarkdownNode[] = [];

  for (const node of tree.children ?? [])
    (node.type === "footnoteDefinition" ? footnotes : body).push(node);

  return { body, footnotes };
}

function renderFootnotes(
  footnotes: MarkdownNode[],
  keyPrefix: string,
  highlightQuote?: string,
): ReactNode {
  if (footnotes.length === 0) return null;

  return (
    <section data-footnotes="" className="footnotes">
      <ol>
        {footnotes.map((definition, index) => (
          <li
            key={`${keyPrefix}:fn:${index}`}
            id={`fn-${definition.label ?? definition.identifier ?? index}`}
          >
            {renderMarkdownChildren(
              definition.children ?? [],
              `${keyPrefix}:fn:${index}`,
              highlightQuote,
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export const markdownHasTitle = (source: string) =>
  (parseMarkdown(source).children ?? []).some(
    (node) => node.type === "heading" && node.depth === 1,
  );

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
      return (
        <MarkdownImage key={key} url={node.url ?? ""} alt={node.alt ?? ""} />
      );
    case "table":
      return renderTable(node, key);
    case "tableRow":
      return renderTableRow(node, key, false, null);
    case "tableCell":
      return (
        <td key={key}>{renderMarkdownChildren(node.children ?? [], key)}</td>
      );
    case "footnoteReference": {
      const label = node.label ?? node.identifier ?? "";

      return (
        <sup key={key}>
          <a data-footnote-ref="" href={`#fn-${label}`} id={`fnref-${label}`}>
            {label}
          </a>
        </sup>
      );
    }

    case "footnoteDefinition":
      return null;
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

  const align = node.align ?? null;

  return (
    <table key={key}>
      {header && (
        <thead>{renderTableRow(header, `${key}:head`, true, align)}</thead>
      )}
      <tbody>
        {body.map((row, index) =>
          renderTableRow(row, `${key}:body:${index}`, false, align),
        )}
      </tbody>
    </table>
  );
}

function renderTableRow(
  node: MarkdownNode,
  key: string,
  isHeader: boolean,
  align: Array<string | null> | null,
): ReactElement {
  const Cell = isHeader ? "th" : "td";

  return (
    <tr key={key}>
      {(node.children ?? []).map((cell, index) => {
        const textAlign = cellAlignment(align?.[index]);

        return createElement(
          Cell,
          {
            key: `${key}:cell:${index}`,
            style: textAlign ? { textAlign } : undefined,
          },
          renderMarkdownChildren(cell.children ?? [], `${key}:cell:${index}`),
        );
      })}
    </tr>
  );
}

function cellAlignment(
  align: string | null | undefined,
): "left" | "center" | "right" | undefined {
  switch (align) {
    case "left":
    case "center":
    case "right":
      return align;
    default:
      return undefined;
  }
}

function MarkdownImage({ url, alt }: { url: string; alt: string }): ReactNode {
  // Phrasing content, so an <img> (a <figure> inside <p> is invalid HTML)
  // that CSS lays out like an image block.
  if (useContext(RemoteImages) && urlProtocol(url) === "https:")
    return (
      <img
        className="whiteboard-image-inline"
        src={url}
        alt={alt}
        loading="lazy"
      />
    );

  // Chat has no store to resolve an image against, so its alt text stands in.
  return alt ? <em>{alt}</em> : null;
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
  const protocol = urlProtocol(value);

  return protocol && ["http:", "https:", "mailto:"].includes(protocol)
    ? value
    : null;
}

/** The scheme a href resolves to; a relative one counts as the page's own. */
function urlProtocol(value: string): string | null {
  try {
    return new URL(value, "http://localhost").protocol;
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
