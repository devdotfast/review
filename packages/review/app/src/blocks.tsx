import { Component, type ReactNode } from "react";

import {
  type Block,
  type BlockType,
  traceQuoteLink,
} from "../../src/review-api/document";
import { MarkdownContent } from "./agent-markdown";
import type { ApiDocumentData } from "./api-document";
import { CallStackDiff } from "./call-stack-diff";
import { RenderedCodeBlock } from "./code-block";
import { CodePeekCard } from "./CodePeek";
import { DatabaseLens } from "./database-lens";
import { SequenceDiagram } from "./diagrams";
import { AnchorLink, ReviewSection } from "./review-components";
import { ReviewDocumentTitle } from "./review-document-surface";
import { SoftwareMap } from "./software-map/SoftwareMap";
import { TraceQuote } from "./trace-quote";

/** A block the store has written: ids are assigned before any write. */
export type StoredBlock = Block & { id: string };

const hasId = (block: Block): block is StoredBlock => block.id !== undefined;

/**
 * The one place a stored block's id is checked, instead of `!` at every use.
 * Returns the same object so memoized nodes keep their identity.
 */
export function stored(block: Block): StoredBlock {
  if (!hasId(block)) throw new Error(`Stored ${block.type} block has no id.`);

  return block;
}

type BlockByType = { [K in BlockType]: Extract<StoredBlock, { type: K }> };

export interface BlockProps<K extends BlockType> {
  node: BlockByType[K];
  data: ApiDocumentData;
  children(nodes: Block[]): ReactNode;
}

export type BlockComponent<K extends BlockType> = (
  props: BlockProps<K>,
) => ReactNode;

function MarkdownBlock({ node, data }: BlockProps<"markdown">) {
  return (
    <MarkdownContent
      source={node.markdown}
      h1={ReviewDocumentTitle}
      renderLink={(href, children) => {
        const quote = traceQuoteLink(href);

        if (quote) {
          const trace = data.traces.get(quote.traceId);

          const event = trace?.events.findIndex(
            (item) => item.id === quote.eventId,
          );

          if (event === undefined || event < 0)
            return <q data-unavailable="trace">{children}</q>;

          return (
            <TraceQuote sessionId={quote.traceId} event={event}>
              {children}
            </TraceQuote>
          );
        }

        const anchor = data.anchors.get(`${node.id}:${href}`);

        return anchor ? (
          <AnchorLink anchor={anchor}>{children}</AnchorLink>
        ) : undefined;
      }}
    />
  );
}

function CodeBlock({ node }: BlockProps<"code">) {
  return (
    <>
      <RenderedCodeBlock code={node.text} language={node.language} />
      {node.caption && <p>{node.caption}</p>}
    </>
  );
}

function DividerBlock() {
  return <hr />;
}

function SectionBlock({ node, data, children }: BlockProps<"section">) {
  return (
    <ReviewSection
      stateKey={`${data.snapshot.reviewId}:${node.id}`}
      title={node.title}
      id={node.id}
      defaultCollapsed={node.defaultCollapsed}
    >
      {children(node.children)}
    </ReviewSection>
  );
}

function CalloutBlock({ node, children }: BlockProps<"callout">) {
  return (
    <blockquote data-tone={node.tone}>
      {node.title && <strong>{node.title}</strong>}
      {children(node.children)}
    </blockquote>
  );
}

function CodePeekBlock({ node }: BlockProps<"code_peek">) {
  return <CodePeekCard source={node.source} />;
}

function SequenceBlock({ node }: BlockProps<"sequence">) {
  return (
    <SequenceDiagram
      id={node.id}
      title={node.title}
      actors={node.actors}
      steps={node.steps}
    />
  );
}

function CallStackDiffBlock({ node }: BlockProps<"call_stack_diff">) {
  return <CallStackDiff title={node.title} base={node.base} head={node.head} />;
}

function DatabaseLensBlock({ node }: BlockProps<"database_lens">) {
  return (
    <DatabaseLens
      id={node.id}
      title={node.title}
      actors={node.actors}
      stores={node.stores}
      useCases={node.useCases}
    />
  );
}

function ImageBlock({ node, data }: BlockProps<"image">) {
  return (
    <figure className="review-image">
      <img src={data.images.get(node.assetId)} alt={node.alt} />
      {node.caption && <figcaption>{node.caption}</figcaption>}
    </figure>
  );
}

// The store checked the quote against its trace at write time; if the trace
// cannot be loaded now, the words still show instead of the canvas failing.
function TraceQuoteBlock({ node, data }: BlockProps<"trace_quote">) {
  const trace = data.traces.get(node.traceId);

  const event =
    trace?.events.findIndex((item) => item.id === node.eventId) ?? -1;

  if (!trace || event < 0)
    return <blockquote data-unavailable="trace">{node.text}</blockquote>;

  return (
    <TraceQuote sessionId={node.traceId} event={event}>
      {node.text}
    </TraceQuote>
  );
}

function SoftwareMapBlock({ node, data }: BlockProps<"software_map">) {
  return (
    <SoftwareMap
      diagramId={node.id}
      model={data.maps.get(node.mapVersionId)}
      pinnedData={data.maps.get(node.mapVersionId)?.pinnedData}
      view={node.focusElementId}
    />
  );
}

type Components = { [K in BlockType]: BlockComponent<K> };

/** Every block kind's component, keyed by type. A kind without a component is a compile error. */
export const blockComponents = {
  markdown: MarkdownBlock,
  code: CodeBlock,
  divider: DividerBlock,
  code_peek: CodePeekBlock,
  sequence: SequenceBlock,
  call_stack_diff: CallStackDiffBlock,
  database_lens: DatabaseLensBlock,
  image: ImageBlock,
  trace_quote: TraceQuoteBlock,
  software_map: SoftwareMapBlock,
  section: SectionBlock,
  callout: CalloutBlock,
} satisfies Components;

/** Render one stored block through its kind's component. */
export function renderBlock<K extends BlockType>(
  type: K,
  node: BlockByType[K],
  data: ApiDocumentData,
  children: (nodes: Block[]) => ReactNode,
): ReactNode {
  // SAFETY: blockComponents satisfies Components, so its entry for K is that kind's component.
  const Component = blockComponents[type] as BlockComponent<K>;

  return (
    <Component node={node} data={data}>
      {children}
    </Component>
  );
}

interface BlockErrorBoundaryProps {
  type: BlockType;
  onError(error: Error): void;
  children: ReactNode;
}

interface BlockErrorBoundaryState {
  error: Error | null;
}

/**
 * One block that throws degrades to one alert; the rest of the document
 * stays readable and the error is still reported as a render diagnostic.
 */
export class BlockErrorBoundary extends Component<
  BlockErrorBoundaryProps,
  BlockErrorBoundaryState
> {
  override state: BlockErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  override render() {
    const { error } = this.state;

    if (error)
      return (
        <div role="alert" data-block-error={this.props.type}>
          This {this.props.type.replaceAll("_", " ")} block could not be
          rendered: {error.message}
        </div>
      );

    return this.props.children;
  }
}
