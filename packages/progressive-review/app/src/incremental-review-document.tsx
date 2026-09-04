import type {
  ReviewDocumentNode,
  ReviewDocumentSnapshot,
  ReviewDocumentStoreBridge,
} from "@dev.fast/review-protocol";
import {
  type ReactElement,
  memo,
  useCallback,
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
  if (snapshot.mode !== "incremental" || !snapshot.nodes) {
    throw new Error("The incremental renderer received a compiled document.");
  }
  return (
    <div
      className="review-incremental-document"
      data-review-document-revision={snapshot.revision}
    >
      {snapshot.nodes.map((node) => (
        <IncrementalReviewNode key={node.id} node={node} />
      ))}
    </div>
  );
}

const IncrementalReviewNode = memo(function IncrementalReviewNode({
  node,
}: {
  node: ReviewDocumentNode;
}): ReactElement {
  return (
    <section
      className={`review-incremental-node review-incremental-node--${node.kind}`}
      data-review-node-id={node.id}
    >
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

function incrementalDocumentTitle(snapshot: ReviewDocumentSnapshot): string {
  for (const node of snapshot.nodes ?? []) {
    if (node.title?.trim()) return node.title.trim();
    const heading = /^#\s+(.+)$/m.exec(node.content);
    if (heading?.[1]) return heading[1].trim();
  }
  return "Review";
}
