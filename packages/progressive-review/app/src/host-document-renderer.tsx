import type {
  HostDocumentState,
  HostInline,
  HostNode,
  ReviewHostSourceBridge,
} from "@dev.fast/review-protocol";
import type { Definition, Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { MDXComponents } from "mdx/types";
import { gfm } from "micromark-extension-gfm";
import {
  Component,
  Fragment,
  type ReactNode,
  createElement,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MarkdownCodeBlock } from "./code-block";
import { ReviewCodePeek } from "./CodePeek";
import {
  type HostDocumentResources,
  HostRichNode,
  type HostRichNodeProps,
  hostAnchorRef,
} from "./host-document-components";
import { AnchorLink, ReviewSection } from "./review-components";

import "./host-document.css";

export interface HostDocumentRendererProps {
  document: HostDocumentState;
  components?: MDXComponents;
  onSourceOpen?: (anchorId: string) => void;
  onSourceRangeOpen?: HostRichNodeProps["onSourceRangeOpen"];
  onError?: (nodeId: string, error: Error) => void;
  resources?: HostDocumentResources;
  source?: ReviewHostSourceBridge;
}

type RenderContext = HostDocumentRendererProps;

/** Renders host-owned JSON and retained evidence, without loading authored code. */
export function HostDocumentRenderer(props: HostDocumentRendererProps) {
  return <DocumentTree key={props.document.reviewId} {...props} />;
}

function DocumentTree(props: HostDocumentRendererProps) {
  return <>{renderChildren(props.document.roots, props)}</>;
}

export function hostDocumentHasTitle(document: HostDocumentState): boolean {
  const hasTitle = (node: Nodes): boolean =>
    (node.type === "heading" && node.depth === 1) ||
    ("children" in node && node.children.some(hasTitle));
  return Object.values(document.nodes).some(
    (node) =>
      (node.type === "heading" && node.level === 1) ||
      (node.type === "markdown" && hasTitle(parseMarkdown(node.markdown))),
  );
}

function parseMarkdown(source: string) {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
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
          revision={`${context.document.reviewVersion}:${revision}`}
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
      return (
        <SafeMarkdown source={node.markdown} components={context.components} />
      );
    case "paragraph":
      return <p>{renderInline(node.content, context)}</p>;
    case "heading":
      return createElement(
        context.components?.[`h${node.level}`] ?? `h${node.level}`,
        { id: `review-heading-${node.id}` },
        renderInline(node.content, context),
      );
    case "code":
      return (
        <>
          <MarkdownCodeBlock>
            <code
              className={
                node.language ? `language-${node.language}` : undefined
              }
            >
              {node.text}
            </code>
          </MarkdownCodeBlock>
          {node.caption && <p>{node.caption}</p>}
        </>
      );
    case "divider":
      return <hr />;
    case "section":
      return (
        <ReviewSection
          stateKey={node.id}
          title={node.title}
          defaultCollapsed={node.defaultCollapsed}
        >
          <h2 id={`review-heading-${node.id}`}>{node.title}</h2>
          {renderChildren(node.children, context)}
        </ReviewSection>
      );
    case "callout":
      return (
        <blockquote data-tone={node.tone}>
          {node.title && <strong>{node.title}</strong>}
          {renderChildren(node.children, context)}
        </blockquote>
      );
    case "code_peek":
      return <HostCodePeek node={node} document={context.document} />;
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

function HostCodePeek({
  node,
  document,
}: {
  node: Extract<HostNode, { type: "code_peek" }>;
  document: HostDocumentState;
}) {
  const anchor = useMemo(
    () => hostAnchorRef(document, node.anchorId),
    [
      node.anchorId,
      document.definitions[node.anchorId],
      document.evidence[node.anchorId],
    ],
  );
  return (
    <>
      <ReviewCodePeek anchor={anchor} />
      {node.caption && <p>{node.caption}</p>}
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
  return (
    <AnchorLink anchor={hostAnchorRef(context.document, anchorId)}>
      {children}
    </AnchorLink>
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
function SafeMarkdown({
  source,
  components,
}: {
  source: string;
  components?: MDXComponents;
}) {
  const tree = useMemo(() => parseMarkdown(source), [source]);
  const definitions = new Map(
    tree.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier, node] as const] : [],
    ),
  );
  return <>{markdownChildren(tree.children, definitions, components)}</>;
}

function markdownChildren(
  nodes: Nodes[],
  definitions: Map<string, Definition>,
  components?: MDXComponents,
  listLoose?: boolean,
): ReactNode {
  return nodes.map((node, index) => (
    <Fragment key={index}>
      {markdownNode(node, definitions, components, listLoose)}
    </Fragment>
  ));
}

function markdownNode(
  node: Nodes,
  definitions: Map<string, Definition>,
  components?: MDXComponents,
  listLoose?: boolean,
): ReactNode {
  if (node.type === "list") {
    const loose = Boolean(
      node.spread || node.children.some((item) => item.spread),
    );
    const className = node.children.some(
      (item) => item.checked !== null && item.checked !== undefined,
    )
      ? "contains-task-list"
      : undefined;
    const items = markdownChildren(
      node.children,
      definitions,
      components,
      loose,
    );
    return node.ordered ? (
      <ol start={node.start ?? undefined} className={className}>
        {items}
      </ol>
    ) : (
      <ul className={className}>{items}</ul>
    );
  }
  if (node.type === "listItem") {
    const checked = node.checked;
    const checkbox =
      checked !== null && checked !== undefined ? (
        <>
          <input type="checkbox" checked={checked} disabled />{" "}
        </>
      ) : null;
    return (
      <li className={checkbox ? "task-list-item" : undefined}>
        {node.children.map((child, index) => {
          if (child.type !== "paragraph")
            return (
              <Fragment key={index}>
                {markdownNode(child, definitions, components)}
              </Fragment>
            );
          const text = (
            <>
              {index === 0 && checkbox}
              {markdownChildren(child.children, definitions, components)}
            </>
          );
          return (listLoose ?? node.spread) ? (
            <p key={index}>{text}</p>
          ) : (
            <Fragment key={index}>{text}</Fragment>
          );
        })}
      </li>
    );
  }
  const children =
    "children" in node
      ? markdownChildren(node.children, definitions, components)
      : null;
  switch (node.type) {
    case "root":
      return children;
    case "text":
    case "html":
      return node.value;
    case "paragraph":
      return <p>{children}</p>;
    case "heading":
      return createElement(
        components?.[`h${node.depth}`] ?? `h${node.depth}`,
        null,
        children,
      );
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
        <MarkdownCodeBlock>
          <code className={node.lang ? `language-${node.lang}` : undefined}>
            {node.value}
          </code>
        </MarkdownCodeBlock>
      );
    case "break":
      return <br />;
    case "thematicBreak":
      return <hr />;
    case "blockquote":
      return <blockquote>{children}</blockquote>;
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
      <div className="review-status" role="alert">
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
    // The identity wrappers are display:contents; animate the existing
    // component's actual boxes, without adding a gutter or changing layout.
    const animations = reduced
      ? []
      : [...(element?.children ?? [])].map((child) =>
          child.animate?.([{ opacity: 0.35 }, { opacity: 1 }], {
            duration: 320,
            easing: "ease-out",
          }),
        );
    const timeout = setTimeout(() => setActive(false), 1400);
    return () => {
      clearTimeout(timeout);
      for (const animation of animations) animation?.cancel();
    };
  }, [revision]);
  return (
    <div
      className="host-document-node"
      data-node-id={id}
      data-host-node-id={id}
      data-authoring={active || undefined}
    >
      <div ref={content} className="host-document-node-content">
        {children}
      </div>
    </div>
  );
}
