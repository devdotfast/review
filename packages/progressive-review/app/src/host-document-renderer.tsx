import type {
  HostDocumentState,
  HostInline,
  HostNode,
  HostSourceQuote,
  HostSourceRange,
  ReviewHostSourceBridge,
} from "@dev.fast/review-protocol";
import type { Definition, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  Component,
  Fragment,
  type ReactNode,
  createElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type HostDocumentResources,
  HostRichNode,
  type HostRichNodeProps,
} from "./host-document-components";

import "./host-document.css";

export interface HostDocumentRendererProps {
  document: HostDocumentState;
  onSourceOpen?: (anchorId: string) => void;
  onSourceRangeOpen?: HostRichNodeProps["onSourceRangeOpen"];
  onError?: (nodeId: string, error: Error) => void;
  resources?: HostDocumentResources;
  source?: ReviewHostSourceBridge;
}

interface RenderContext extends HostDocumentRendererProps {
  collapsed: Map<string, boolean>;
}

/** Renders host-owned JSON and retained evidence, without loading authored code. */
export function HostDocumentRenderer(props: HostDocumentRendererProps) {
  return <DocumentTree key={props.document.documentId} {...props} />;
}

function DocumentTree(props: HostDocumentRendererProps) {
  const collapsed = useRef(new Map<string, boolean>()).current;
  useEffect(() => {
    for (const id of collapsed.keys()) {
      if (!(id in props.document.nodes)) collapsed.delete(id);
    }
  }, [collapsed, props.document.nodes]);
  const context: RenderContext = { ...props, collapsed };
  return (
    <article
      className="host-document"
      data-document-id={props.document.documentId}
      data-document-version={props.document.version}
    >
      {renderChildren(props.document.roots, context)}
    </article>
  );
}

function renderChildren(ids: string[], context: RenderContext): ReactNode {
  return ids.map((id) => {
    const node = context.document.nodes[id];
    // Include retained source dependencies: a repin can change a peek without
    // changing its authored node. Unrelated document commits do not animate it.
    const revision = JSON.stringify([
      node,
      node?.type === "code_peek"
        ? [
            context.document.definitions[node.anchorId],
            context.document.evidence[node.anchorId],
          ]
        : null,
    ]);
    return (
      <NodeActivity key={id} id={id} revision={revision}>
        <NodeBoundary
          nodeId={id}
          revision={`${context.document.version}:${revision}`}
          resources={context.resources}
          onError={context.onError}
        >
          <NodeContent id={id} context={context} />
        </NodeBoundary>
      </NodeActivity>
    );
  });
}

function NodeContent({ id, context }: { id: string; context: RenderContext }) {
  const node = context.document.nodes[id];
  if (!node) throw new Error(`The document is missing node ${id}.`);
  switch (node.type) {
    case "markdown":
      return <SafeMarkdown source={node.markdown} />;
    case "paragraph":
      return <p>{renderInline(node.content, context)}</p>;
    case "heading":
      return createElement(
        `h${node.level}`,
        { id: `review-heading-${node.id}` },
        renderInline(node.content, context),
      );
    case "code":
      return (
        <figure className="host-document-code">
          <pre>
            <code data-language={node.language}>{node.text}</code>
          </pre>
          {node.caption && <figcaption>{node.caption}</figcaption>}
        </figure>
      );
    case "divider":
      return <hr />;
    case "section":
      return <CollapsibleSection node={node} context={context} />;
    case "callout":
      return (
        <aside className="host-document-callout" data-tone={node.tone}>
          {node.title && <strong>{node.title}</strong>}
          {renderChildren(node.children, context)}
        </aside>
      );
    case "code_peek":
      return <RetainedCodePeek node={node} context={context} />;
    default:
      return (
        <HostRichNode
          node={node}
          document={context.document}
          resources={context.resources}
          onSourceOpen={context.onSourceOpen}
          onSourceRangeOpen={context.onSourceRangeOpen}
          onError={(error) => context.onError?.(node.id, error)}
        />
      );
  }
}

function CollapsibleSection({
  node,
  context,
}: {
  node: Extract<HostNode, { type: "section" }>;
  context: RenderContext;
}) {
  const [collapsed, setCollapsed] = useState(
    () => context.collapsed.get(node.id) ?? node.defaultCollapsed,
  );
  const bodyId = `review-section-${node.id}`;
  return (
    <section className="host-document-section">
      <h2>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => {
            const next = !collapsed;
            context.collapsed.set(node.id, next);
            setCollapsed(next);
          }}
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> {node.title}
        </button>
      </h2>
      <div id={bodyId} hidden={collapsed}>
        {renderChildren(node.children, context)}
      </div>
    </section>
  );
}

function RetainedCodePeek({
  node,
  context,
}: {
  node: Extract<HostNode, { type: "code_peek" }>;
  context: RenderContext;
}) {
  const anchor = context.document.definitions[node.anchorId];
  const quote = context.document.evidence[node.anchorId];
  if (anchor?.kind !== "anchor" || !quote) {
    throw new Error(`Stored source evidence is missing for ${node.anchorId}.`);
  }
  const retained = (
    <figure
      id={`review-source-${node.id}`}
      className="host-document-code host-document-code-peek"
      data-anchor-id={node.anchorId}
    >
      <figcaption>
        <strong>{anchor.title}</strong>
        <SourceLink anchorId={node.anchorId} context={context}>
          {quote.span.file}:{quote.span.fromLine}–{quote.span.toLine}
        </SourceLink>
        <small title={quote.span.commit}>
          {quote.span.commit.slice(0, 12)}
        </small>
      </figcaption>
      <pre>
        <code>{quote.text}</code>
      </pre>
      {node.caption && <figcaption>{node.caption}</figcaption>}
    </figure>
  );
  return context.source ? (
    <NativeCodePeek
      key={node.id}
      bridge={context.source}
      document={context.document}
      nodeId={node.id}
      anchorId={node.anchorId}
      title={anchor.title}
      range={anchor.source}
      quote={quote}
      caption={node.caption}
      onOpen={() => context.onSourceOpen?.(node.anchorId)}
      fallback={retained}
    />
  ) : (
    retained
  );
}

function NativeCodePeek({
  bridge,
  document,
  nodeId,
  anchorId,
  title,
  range,
  quote,
  caption,
  onOpen,
  fallback,
}: {
  bridge: ReviewHostSourceBridge;
  document: HostDocumentState;
  nodeId: string;
  anchorId: string;
  title: string;
  range: HostSourceRange;
  quote: HostSourceQuote;
  caption?: string;
  onOpen(): void;
  fallback: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  const [height, setHeight] = useState(150);
  const [unavailable, setUnavailable] = useState(false);
  const identity = JSON.stringify([
    document.reviewId,
    anchorId,
    quote.span.repositoryId,
    quote.span.commit,
    quote.span.blob,
    quote.sha256,
    range.side,
    range.file,
    range.fromLine,
    range.toLine,
    title,
  ]);
  useEffect(() => {
    if (!container.current) return;
    setUnavailable(false);
    try {
      const handle = bridge.createPeek({
        container: container.current,
        title,
        target: {
          reviewId: document.reviewId,
          documentVersion: document.version,
          range,
        },
        onDidOpen: () => open.current(),
      });
      setHeight(handle.height);
      const heightSubscription = handle.onDidChangeHeight(setHeight);
      const errorSubscription = handle.onDidError(() => {
        setUnavailable(true);
        handle.dispose();
      });
      return () => {
        heightSubscription.dispose();
        errorSubscription.dispose();
        handle.dispose();
      };
    } catch {
      setUnavailable(true);
    }
    // The source identity, not the working document version, owns this editor.
    // Unrelated edits keep its selection, fold and scroll state intact.
  }, [bridge, identity]);
  return (
    <>
      <figure
        hidden={unavailable}
        id={unavailable ? undefined : `review-source-${nodeId}`}
        data-anchor-id={anchorId}
      >
        <div ref={container} style={{ height }} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      {unavailable && (
        <>
          <p>Full source unavailable. Showing the retained excerpt.</p>
          {fallback}
        </>
      )}
    </>
  );
}

function SourceLink({
  anchorId,
  context,
  children,
}: {
  anchorId: string;
  context: RenderContext;
  children: ReactNode;
}) {
  if (context.document.definitions[anchorId]?.kind !== "anchor") {
    throw new Error(`The document is missing source anchor ${anchorId}.`);
  }
  return context.onSourceOpen ? (
    <button
      type="button"
      className="host-document-source-link"
      onClick={() => context.onSourceOpen?.(anchorId)}
    >
      {children}
    </button>
  ) : (
    <span className="host-document-source-label">{children}</span>
  );
}

const markTags = {
  strong: "strong",
  emphasis: "em",
  strike: "del",
  underline: "u",
  sub: "sub",
  sup: "sup",
  highlight: "mark",
} as const;

function renderInline(
  content: HostInline[],
  context: RenderContext,
): ReactNode {
  return content.map((item, index) => {
    switch (item.type) {
      case "text":
        return (
          <Fragment key={index}>
            {(item.marks ?? []).reduce<ReactNode>(
              (child, mark) => createElement(markTags[mark], null, child),
              item.text,
            )}
          </Fragment>
        );
      case "code":
        return <code key={index}>{item.text}</code>;
      case "break":
        return <br key={index} />;
      case "link":
        return (
          <SafeLink key={index} href={item.href}>
            {item.text}
          </SafeLink>
        );
      case "anchor_link":
        return (
          <SourceLink key={index} anchorId={item.anchorId} context={context}>
            {item.text}
          </SourceLink>
        );
    }
  });
}

/** Raw HTML is text; images require an explicit host-managed image node. */
function SafeMarkdown({ source }: { source: string }) {
  const tree = useMemo(
    () =>
      fromMarkdown(source, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }),
    [source],
  );
  const definitions = new Map(
    tree.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier, node] as const] : [],
    ),
  );
  return <>{markdownChildren(tree.children, definitions)}</>;
}

function markdownChildren(
  nodes: Nodes[],
  definitions: Map<string, Definition>,
): ReactNode {
  return nodes.map((node, index) => (
    <Fragment key={index}>{markdownNode(node, definitions)}</Fragment>
  ));
}

function markdownNode(
  node: Nodes,
  definitions: Map<string, Definition>,
): ReactNode {
  const children =
    "children" in node ? markdownChildren(node.children, definitions) : null;
  switch (node.type) {
    case "root":
      return children;
    case "text":
    case "html":
      return node.value;
    case "paragraph":
      return <p>{children}</p>;
    case "heading":
      return createElement(`h${node.depth}`, null, children);
    case "strong":
      return <strong>{children}</strong>;
    case "emphasis":
      return <em>{children}</em>;
    case "delete":
      return <del>{children}</del>;
    case "inlineCode":
      return <code>{node.value}</code>;
    case "code":
      return (
        <pre>
          <code data-language={node.lang ?? undefined}>{node.value}</code>
        </pre>
      );
    case "break":
      return <br />;
    case "thematicBreak":
      return <hr />;
    case "blockquote":
      return <blockquote>{children}</blockquote>;
    case "list":
      return node.ordered ? (
        <ol start={node.start ?? undefined}>{children}</ol>
      ) : (
        <ul>{children}</ul>
      );
    case "listItem":
      return (
        <li>
          {node.checked !== null && node.checked !== undefined && (
            <input type="checkbox" checked={node.checked} disabled />
          )}
          {children}
        </li>
      );
    case "link":
      return <SafeLink href={node.url}>{children}</SafeLink>;
    case "linkReference":
      return (
        <SafeLink href={definitions.get(node.identifier)?.url ?? ""}>
          {children}
        </SafeLink>
      );
    case "image":
    case "imageReference":
      return <span>{node.alt}</span>;
    case "table":
      return (
        <table>
          <thead>
            {node.children.slice(0, 1).map((row, index) => (
              <tr key={index}>
                {row.children.map((cell, i) => (
                  <th
                    key={i}
                    style={{ textAlign: node.align?.[i] ?? undefined }}
                  >
                    {markdownChildren(cell.children, definitions)}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {node.children.slice(1).map((row, index) => (
              <tr key={index}>
                {row.children.map((cell, i) => (
                  <td
                    key={i}
                    style={{ textAlign: node.align?.[i] ?? undefined }}
                  >
                    {markdownChildren(cell.children, definitions)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "footnoteReference":
      return <sup>{node.label ?? node.identifier}</sup>;
    case "footnoteDefinition":
      return (
        <aside>
          {node.label ?? node.identifier}. {children}
        </aside>
      );
    case "definition":
      return null;
    default:
      return children;
  }
}

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  // Reject relative/filesystem URLs and controls rather than inheriting the
  // desktop's origin or accidentally dispatching a custom protocol handler.
  let safe = /^#[A-Za-z0-9_-]+$/.test(href);
  if (!/[\u0000-\u0020\u007f]/.test(href)) {
    try {
      safe ||= ["https:", "http:", "mailto:"].includes(new URL(href).protocol);
    } catch {
      /* Not an absolute supported URL. */
    }
  }
  return safe ? (
    <a href={href} rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

interface NodeBoundaryState {
  error: Error | null;
  revision: string;
  resources?: HostDocumentResources;
}

class NodeBoundary extends Component<
  {
    nodeId: string;
    revision: string;
    onError?: (nodeId: string, error: Error) => void;
    resources?: HostDocumentResources;
    children: ReactNode;
  },
  NodeBoundaryState
> {
  state: NodeBoundaryState = {
    error: null,
    revision: this.props.revision,
    resources: this.props.resources,
  };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(
    props: { revision: string; resources?: HostDocumentResources },
    state: NodeBoundaryState,
  ) {
    return props.revision !== state.revision ||
      props.resources !== state.resources
      ? { error: null, revision: props.revision, resources: props.resources }
      : null;
  }
  componentDidCatch(error: Error) {
    this.props.onError?.(this.props.nodeId, error);
  }
  render() {
    return this.state.error ? (
      <div className="host-document-node-error" role="alert">
        <strong>This part of the review could not be displayed.</strong>
        <p>{this.state.error.message}</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

function NodeActivity({
  id,
  revision,
  children,
}: {
  id: string;
  revision: string;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    setActive(true);
    const reduced = element?.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const animation = reduced
      ? undefined
      : element?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], {
          duration: 320,
          easing: "ease-out",
        });
    const timeout = setTimeout(() => setActive(false), 1400);
    return () => {
      clearTimeout(timeout);
      animation?.cancel();
    };
  }, [revision]);
  return (
    <div
      className="host-document-node"
      data-node-id={id}
      data-authoring={active || undefined}
    >
      <span className="host-document-node-activity" aria-hidden="true" />
      <div ref={content} className="host-document-node-content">
        {children}
      </div>
    </div>
  );
}
