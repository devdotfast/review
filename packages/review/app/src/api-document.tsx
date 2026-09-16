import type { ReviewCommitSummary } from "@dev.fast/review-protocol";
import { type ReactNode, memo, useLayoutEffect, useMemo, useRef } from "react";

import type { ReviewApiClient } from "../../src/review-api/client";
import {
  type Block,
  type Source,
  elements,
  sourceReferences,
} from "../../src/review-api/document";
import type { LocalReviewData } from "../../src/review-api/local-data";
import type { Snapshot } from "../../src/review-api/store";
import type { DocumentPeekableAnchor } from "../../src/review-document-data";
import type { NormalizedSoftwareModel } from "../../src/software-map-model";
import { MarkdownContent, markdownHasTitle } from "./agent-markdown";
import { CallStackDiff } from "./call-stack-diff";
import { RenderedCodeBlock } from "./code-block";
import { CodePeekCard } from "./CodePeek";
import { DatabaseLens } from "./database-lens";
import { SequenceDiagram } from "./diagrams";
import { AnchorLink, ReviewSection } from "./review-components";
import { ReviewDocumentTitle } from "./review-document-surface";
import type { SoftwareMapResolvedDataPayload } from "./software-map/software-map-snapshot";
import { SoftwareMap } from "./software-map/SoftwareMap";
import { TraceQuote } from "./trace-quote";

import "./api-document.css";

interface Trace {
  label: string;
  events: { id: string; role: string; text: string }[];
}

export interface ApiDocumentData {
  snapshot: Snapshot;
  commits: ReviewCommitSummary[];
  anchors: Map<string, DocumentPeekableAnchor>;
  images: Map<string, string>;
  traces: Map<string, Trace>;
  maps: Map<
    string,
    NormalizedSoftwareModel & {
      pinnedData: SoftwareMapResolvedDataPayload & {
        side: "base" | "head";
        diagramId?: string;
      };
    }
  >;
}

/** Cache only immutable resources and commit-addressed quotes, for this canvas. */
export function createDocumentLoader(client: ReviewApiClient) {
  const cache = new Map<string, Promise<unknown>>();
  const urls = new Set<string>();
  let disposed = false;

  const once = <T,>(key: string, read: () => Promise<T>): Promise<T> => {
    if (!cache.has(key))
      cache.set(
        key,
        read().catch((error) => {
          cache.delete(key);
          throw error;
        }),
      );

    // SAFETY: each key identifies one immutable resource and its loader's result type.
    return cache.get(key) as Promise<T>;
  };

  return {
    dispose() {
      disposed = true;

      for (const url of urls) URL.revokeObjectURL(url);
      cache.clear();
    },
    async load(snapshot: Snapshot): Promise<ApiDocumentData> {
      const data: ApiDocumentData = {
        snapshot,
        commits: await once(`commits:${JSON.stringify(snapshot.pins)}`, () =>
          client.read<ReviewCommitSummary[]>(
            `/${snapshot.reviewId}/commits?version=${snapshot.version}`,
          ),
        ),
        anchors: new Map(),
        images: new Map(),
        traces: new Map(),
        maps: new Map(),
      };

      for (const { id, source, label } of sourceReferences(snapshot.document, {
        tolerant: true,
      })) {
        data.anchors.set(
          id,
          sourceAnchor(
            id,
            source,
            label ?? `${source.file}:${source.fromLine}`,
          ),
        );
      }

      await Promise.all(
        elements(snapshot.document).map(async (node) => {
          if (node.type === "image") {
            const url = await once(`image:${node.assetId}`, async () => {
              const blob = await (
                await client.response(
                  `/resources/${encodeURIComponent(node.assetId)}`,
                )
              ).blob();

              if (disposed) throw new Error("Canvas closed.");
              const url = URL.createObjectURL(blob);
              urls.add(url);

              return url;
            });

            data.images.set(node.assetId, url);
          }

          if (node.type === "trace_quote")
            data.traces.set(
              node.traceId,
              await once(`trace:${node.traceId}`, () =>
                client.read<Trace>(
                  `/resources/${encodeURIComponent(node.traceId)}`,
                ),
              ),
            );

          if (node.type === "software_map") {
            const model = await once(
              `map:${node.mapVersionId}:${JSON.stringify(snapshot.pins)}`,
              async () => {
                const saved = await client.read<
                  Awaited<ReturnType<LocalReviewData["map"]>>
                >(
                  `/${snapshot.reviewId}/maps/${encodeURIComponent(node.mapVersionId)}?version=${snapshot.version}`,
                );

                return {
                  ...saved,
                  pinnedData: {
                    side: saved.side,
                    counts: new Map(Object.entries(saved.countsByElementPath)),
                    unmappedByElementPath: new Map(
                      Object.entries(saved.unmappedByElementPath),
                    ),
                  },
                  elementsByPath: new Map(
                    saved.elements.map((element) => [element.path, element]),
                  ),
                };
              },
            );

            if (!data.maps.has(node.mapVersionId))
              data.maps.set(node.mapVersionId, {
                ...model,
                pinnedData: { ...model.pinnedData, diagramId: node.id },
              });
          }
        }),
      );

      return data;
    },
  };
}

export function sourceAnchor(
  id: string,
  source: Source,
  title: string,
): DocumentPeekableAnchor {
  return { __kind: "db-anchor-ref", id, title, peek: source };
}

export function ApiDocument({ data }: { data: ApiDocumentData }) {
  const hasTitle = useMemo(
    () =>
      elements(data.snapshot.document).some(
        (node) => node.type === "markdown" && markdownHasTitle(node.markdown),
      ),
    [data.snapshot.document],
  );

  return (
    <>
      {!hasTitle && (
        <ReviewDocumentTitle>{data.snapshot.title}</ReviewDocumentTitle>
      )}
      {data.snapshot.document.map((node) => (
        <DocumentNode key={node.id} node={node} data={data} />
      ))}
    </>
  );
}

// Memoized: unrelated App renders must not rebuild every block's view models.
const DocumentNode = memo(function DocumentNode({
  node,
  data,
}: {
  node: Block;
  data: ApiDocumentData;
}) {
  const revision = useMemo(() => JSON.stringify(node), [node]);

  const children = (nodes: Block[]) =>
    nodes.map((child) => (
      <DocumentNode key={child.id} node={child} data={data} />
    ));

  let content: ReactNode;

  switch (node.type) {
    case "markdown":
      content = (
        <MarkdownContent
          source={node.markdown}
          h1={ReviewDocumentTitle}
          renderLink={(href, children) => {
            const anchor = data.anchors.get(`${node.id}:${href}`);

            return anchor ? (
              <AnchorLink anchor={anchor}>{children}</AnchorLink>
            ) : undefined;
          }}
        />
      );
      break;
    case "code":
      content = (
        <>
          <RenderedCodeBlock code={node.text} language={node.language} />
          {node.caption && <p>{node.caption}</p>}
        </>
      );
      break;
    case "divider":
      content = <hr />;
      break;
    case "section":
      content = (
        <ReviewSection
          stateKey={`${data.snapshot.reviewId}:${node.id}`}
          title={node.title}
          id={node.id}
          defaultCollapsed={node.defaultCollapsed}
        >
          {children(node.children)}
        </ReviewSection>
      );
      break;
    case "callout":
      content = (
        <blockquote data-tone={node.tone}>
          {node.title && <strong>{node.title}</strong>}
          {children(node.children)}
        </blockquote>
      );
      break;
    case "code_peek":
      content = <CodePeekCard source={node.source} />;
      break;
    case "sequence":
      content = (
        <SequenceDiagram
          id={node.id!}
          title={node.title}
          actors={node.actors}
          steps={node.steps}
        />
      );
      break;
    case "call_stack_diff":
      content = (
        <CallStackDiff title={node.title} base={node.base} head={node.head} />
      );
      break;

    case "database_lens":
      content = (
        <DatabaseLens
          id={node.id!}
          title={node.title}
          actors={node.actors}
          stores={node.stores}
          useCases={node.useCases}
        />
      );
      break;
    case "image":
      content = (
        <figure className="review-image">
          <img src={data.images.get(node.assetId)} alt={node.alt} />
          {node.caption && <figcaption>{node.caption}</figcaption>}
        </figure>
      );
      break;
    case "trace_quote":
      content = (
        <TraceQuote
          sessionId={node.traceId}
          event={data.traces
            .get(node.traceId)!
            .events.findIndex((event) => event.id === node.eventId)}
        >
          {node.text}
        </TraceQuote>
      );
      break;
    case "software_map":
      content = (
        <SoftwareMap
          diagramId={node.id}
          model={data.maps.get(node.mapVersionId)}
          pinnedData={data.maps.get(node.mapVersionId)?.pinnedData}
          view={node.focusElementId}
        />
      );
      break;
  }

  return (
    <NodeReveal id={node.id!} revision={revision}>
      {content}
    </NodeReveal>
  );
});

function NodeReveal({
  id,
  revision,
  children,
}: {
  id: string;
  revision: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Clip each content box; no overlay can spill onto adjacent document content.
    const animations = [...(root.current?.children ?? [])].map((element) =>
      element.animate?.(
        [
          { opacity: 0.35, clipPath: "inset(0 0 100% 0)" },
          { opacity: 1, clipPath: "inset(0)" },
        ],
        { duration: 200, easing: "ease-out" },
      ),
    );

    return () => animations.forEach((animation) => animation?.cancel());
  }, [revision]);

  return (
    <div className="api-document-node" data-review-node-id={id} ref={root}>
      {children}
    </div>
  );
}
