import type {
  ReviewDocumentNode,
  ReviewDocumentSnapshot,
  ReviewDocumentStoreBridge,
} from "@dev.fast/review-protocol";
import {
  type CSSProperties,
  type ReactElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { AgentMarkdown } from "./agent-markdown";
import { RenderedCodeBlock } from "./code-block";
import type {
  ReadyReviewDocumentEntry,
  ReviewDocumentComponent,
} from "./review-documents-runtime";

/**
 * Adapts the host-owned document store to the existing document runtime. The
 * component identity is stable for the lifetime of the store, so document
 * updates do not reset panels, scroll position, or view-local React state.
 */
export function createIncrementalReviewDocumentEntry(
  store: ReviewDocumentStoreBridge,
): ReadyReviewDocumentEntry {
  const initial = store.getSnapshot();
  const Component: ReviewDocumentComponent = function IncrementalDocument() {
    return <IncrementalReviewDocument store={store} />;
  };
  return {
    slug: "incremental-review",
    routePath: initial.routePath,
    filePath: `incremental:${initial.reviewId}:${initial.routePath}`,
    title: incrementalDocumentTitle(initial),
    documentSoftwareModels: [],
    anchors: new Map(),
    anchorContents: new Map(),
    Component,
    isDefault: initial.routePath === "/",
  };
}

export function IncrementalReviewDocument({
  store,
}: {
  store: ReviewDocumentStoreBridge;
}): ReactElement {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = store.subscribe(listener);
      return () => subscription.dispose();
    },
    [store],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
  const authoringTargetNodeId = useSyncExternalStore(
    subscribe,
    () => store.getAuthoringTargetNodeId(),
    () => store.getAuthoringTargetNodeId(),
  );
  const previousNodeIds = useRef<ReadonlySet<string> | null>(null);
  const enteringNodeIds = new Set(
    previousNodeIds.current
      ? (snapshot.nodes ?? [])
          .filter((node) => !previousNodeIds.current?.has(node.id))
          .map((node) => node.id)
      : [],
  );
  useEffect(() => {
    previousNodeIds.current = new Set(snapshot.nodes?.map((node) => node.id));
  }, [snapshot.nodes, snapshot.revision]);
  if (snapshot.mode !== "incremental" || !snapshot.nodes) {
    throw new Error("The incremental renderer received a compiled document.");
  }
  return (
    <div
      className="review-incremental-document"
      data-review-document-revision={snapshot.revision}
    >
      {snapshot.nodes.map((node) => (
        <IncrementalReviewNode
          key={node.id}
          node={node}
          isAuthoring={authoringTargetNodeId === node.id}
          isEntering={enteringNodeIds.has(node.id)}
        />
      ))}
    </div>
  );
}

const IncrementalReviewNode = memo(function IncrementalReviewNode({
  node,
  isAuthoring,
  isEntering,
}: {
  node: ReviewDocumentNode;
  isAuthoring: boolean;
  isEntering: boolean;
}): ReactElement {
  const className = [
    "review-incremental-node",
    `review-incremental-node--${node.kind}`,
    isAuthoring ? "review-incremental-node--authoring-active" : undefined,
    isEntering ? "review-incremental-node--entering" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section
      className={className}
      data-review-node-id={node.id}
      {...(isAuthoring ? { "data-review-authoring-target": "true" } : {})}
    >
      {isAuthoring ? <AuthoringSparkles /> : null}
      {node.kind === "code" ? (
        <RenderedCodeBlock
          className="markdown-code-block"
          code={node.content}
          language={node.language}
        />
      ) : (
        <>
          {node.kind === "callout" && node.title ? (
            <strong className="review-incremental-callout-title">
              {node.title}
            </strong>
          ) : null}
          <AgentMarkdown
            className={
              node.kind === "callout"
                ? `review-incremental-callout review-incremental-callout--${node.tone ?? "info"}`
                : "review-incremental-markdown"
            }
            source={node.content}
          />
        </>
      )}
    </section>
  );
});

const AUTHORING_SPARKLE_COUNT = 28;

function AuthoringSparkles(): ReactElement {
  return (
    <span
      className="review-incremental-node__authoring-sparkles"
      aria-hidden="true"
    >
      {Array.from({ length: AUTHORING_SPARKLE_COUNT }, (_, index) => (
        <i
          key={index}
          style={
            // SAFETY: React accepts custom CSS properties at runtime; the
            // standard CSSProperties type does not model their names.
            {
              "--review-sparkle-index": index,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

function incrementalDocumentTitle(snapshot: ReviewDocumentSnapshot): string {
  for (const node of snapshot.nodes ?? []) {
    if (node.title?.trim()) return node.title.trim();
    const heading = /^#\s+(.+)$/m.exec(node.content);
    if (heading?.[1]) return heading[1].trim();
  }
  return "Review";
}
