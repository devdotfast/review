import type { ReviewCommitSummary } from "@dev.fast/review-protocol";
import {
  type ReactNode,
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ReviewApiClient } from "../../src/review-api/client";
import {
  type Block,
  type Source,
  elements,
  resourceReferences,
  sourceReferences,
} from "../../src/review-api/document";
import type { LocalReviewData } from "../../src/review-api/local-data";
import type { Snapshot } from "../../src/review-api/store";
import type { DocumentPeekableAnchor } from "../../src/review-document-data";
import type { NormalizedSoftwareModel } from "../../src/software-map-model";
import { markdownHasTitle } from "./agent-markdown";
import { type ApiHeadingIds, apiHeadingIds } from "./api-document-headings";
import {
  BlockErrorBoundary,
  type StoredBlock,
  renderBlock,
  stored,
} from "./blocks";
import { useReviewSession } from "./host/review-session";
import { reportReviewDocumentRenderError } from "./review-document-error-report";
import { ReviewDocumentTitle } from "./review-document-surface";
import { cssIdentifier, scrollToReviewHeading } from "./review-heading-scroll";
import { useReviewRoots } from "./review-root-context";
import type { SoftwareMapResolvedDataPayload } from "./software-map/software-map-snapshot";

import "./api-document.css";

interface Trace {
  label: string;
  events: { id: string; role: string; text: string }[];
}

export interface ApiDocumentData {
  snapshot: Snapshot;
  /** The document's heading slugs, resolved once per snapshot. */
  headings: ApiHeadingIds;
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
        headings: apiHeadingIds(snapshot.document),
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
        resourceReferences(snapshot.document).map(async (node) => {
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

          // A trace that cannot be loaded leaves its quote to render as text.
          if (node.type === "trace_quote") {
            const loaded = await once(`trace:${node.traceId}`, () =>
              client.read<Trace>(
                `/resources/${encodeURIComponent(node.traceId)}`,
              ),
            ).catch(() => undefined);

            if (loaded) data.traces.set(node.traceId, loaded);
          }

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

export function ApiDocument({
  data,
  softwareMapEnabled = true,
}: {
  data: ApiDocumentData;
  softwareMapEnabled?: boolean;
}) {
  useHeadingFragments();

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
        <DocumentNode
          key={node.id}
          node={stored(node)}
          data={data}
          softwareMapEnabled={softwareMapEnabled}
        />
      ))}
    </>
  );
}

/** Follows a `#fragment` link to a heading of this document: the document
 * scrolls itself, since the heading can sit inside a collapsed section the
 * browser would never reach. An unknown fragment is left to the browser. */
function useHeadingFragments(): void {
  const roots = useReviewRoots();

  useEffect(() => {
    const article = roots?.articleRef.current;

    if (!article) return;

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey)
        return;

      const target = event.target;

      const link =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>('a[href^="#"]')
          : null;

      const id = link?.getAttribute("href")?.slice(1);

      if (!id || !article.querySelector(`#${cssIdentifier(id)}`)) return;
      event.preventDefault();
      scrollToReviewHeading(
        id,
        article,
        roots?.scrollRegionRef.current ?? null,
      );
    };

    article.addEventListener("click", onClick);

    return () => article.removeEventListener("click", onClick);
  }, [roots]);
}

// Memoized: unrelated App renders must not rebuild every block's view models.
export const DocumentNode = memo(function DocumentNode({
  node,
  data,
  softwareMapEnabled,
}: {
  node: StoredBlock;
  data: ApiDocumentData;
  softwareMapEnabled: boolean;
}) {
  const revision = useMemo(() => JSON.stringify(node), [node]);
  const session = useReviewSession();

  const children = (nodes: Block[]) =>
    nodes.map((child) => (
      <DocumentNode
        key={child.id}
        node={stored(child)}
        data={data}
        softwareMapEnabled={softwareMapEnabled}
      />
    ));

  if (
    node.type === "software_map" &&
    (!softwareMapEnabled || data.snapshot.origin?.tutorial)
  )
    return null;

  return (
    <NodeReveal
      id={node.id}
      revision={revision}
      copyProse={node.type === "markdown" || node.type === "trace_quote"}
    >
      <BlockErrorBoundary
        type={node.type}
        onError={(error) => reportReviewDocumentRenderError(session, error)}
      >
        {renderBlock(node.type, node, data, children)}
      </BlockErrorBoundary>
    </NodeReveal>
  );
});

/** False until the document has painted once: the reveal is for blocks that
 * change or arrive afterwards, not for a whole document appearing at once. */
const RevealSettled = createContext(false);

/** Wrap the first render of a document so its blocks do not all wipe in. */
export function RevealAfterFirstPaint({ children }: { children: ReactNode }) {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(true);
  }, []);

  return (
    <RevealSettled.Provider value={settled}>{children}</RevealSettled.Provider>
  );
}

function NodeReveal({
  copyProse,
  id,
  revision,
  children,
}: {
  copyProse: boolean;
  id: string;
  revision: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const settled = useContext(RevealSettled);
  useLayoutEffect(() => {
    if (!settled) return;

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
    <div
      className="api-document-node"
      data-review-node-id={id}
      data-review-copy-prose={copyProse || undefined}
      ref={root}
    >
      {children}
    </div>
  );
}
