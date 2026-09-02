import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer, defineRegistry } from "@json-render/react";
import { createElement, type ReactNode } from "react";

import type { AnchorRef, SequenceDiagramProps } from "../../src/authoring";
import { liveReviewCatalog } from "../../src/live-review-catalog";
import type { LiveReviewTutorialProps } from "../../src/live-review-catalog";
import type { LiveReviewPage } from "../../src/live-review-types";
import { MarkdownContent } from "./agent-markdown";
import { SequenceDiagram } from "./diagrams";
import { LiveTutorialDocument } from "./live-tutorial-document";
import { ReviewSection } from "./review-components";
import { ReviewDocumentMetaLine } from "./review-doc-meta";
import type { ReadyReviewDocumentEntry } from "./review-document";
import { useActiveReviewDocument } from "./review-document-context";

const { registry } = defineRegistry(liveReviewCatalog, {
  components: {
    ReviewNode: ({ props, children }) => (
      <ReviewNode nodeId={props.nodeId} depth={props.depth} title={props.title}>
        {children}
      </ReviewNode>
    ),
    Markdown: ({ props }) => <MarkdownContent source={props.source} />,
    SequenceDiagram: ({ props }) => (
      <SequenceDiagram {...(props as SequenceDiagramProps)} />
    ),
    Tutorial: ({ props }) => (
      <LiveTutorialDocument {...(props as LiveReviewTutorialProps)} />
    ),
  },
});

function ReviewNode({
  nodeId,
  depth,
  title,
  children,
}: {
  nodeId: string;
  depth: number;
  title?: string;
  children?: ReactNode;
}) {
  if (depth === 0) {
    return (
      <div
        className="review-live-node review-live-node--root"
        data-review-node-id={nodeId}
      >
        {title && <h1>{title}</h1>}
        {title && <ReviewDocumentMetaLine />}
        {children}
      </div>
    );
  }
  if (depth === 1 && title) {
    return (
      <div className="review-live-node" data-review-node-id={nodeId}>
        <ReviewSection title={title}>
          <h2>{title}</h2>
          {children}
        </ReviewSection>
      </div>
    );
  }
  return (
    <div className="review-live-node" data-review-node-id={nodeId}>
      {title && createElement(`h${Math.min(depth + 1, 6)}`, {}, title)}
      {children}
    </div>
  );
}

function LiveReviewDocument() {
  const document = useActiveReviewDocument();
  if (!document.liveSpec) {
    throw new Error("The live Review document has no validated projection.");
  }
  return (
    <JSONUIProvider registry={registry}>
      <Renderer spec={document.liveSpec} registry={registry} />
    </JSONUIProvider>
  );
}

export function createLiveReviewDocument(
  page: LiveReviewPage,
): ReadyReviewDocumentEntry {
  const root = page.nodes[page.rootNodeId];
  if (!root) throw new Error(`Live Review root is missing: ${page.rootNodeId}`);
  const { anchors, anchorContents } = liveReviewAnchors(page.projection);
  return {
    slug: page.id,
    routePath: "/",
    filePath: `live-review:${page.id}`,
    title: root.title ?? "Review",
    documentSoftwareModels: [],
    anchors,
    anchorContents,
    liveSpec: page.projection,
    Component: LiveReviewDocument,
    isDefault: true,
  };
}

function liveReviewAnchors(spec: Spec): {
  anchors: ReadonlyMap<string, AnchorRef>;
  anchorContents: ReadonlyMap<string, string>;
} {
  const anchors = new Map<string, AnchorRef>();
  const anchorContents = new Map<string, string>();
  for (const element of Object.values(spec.elements)) {
    if (element.type === "Tutorial") {
      for (const anchor of Object.values(
        (element.props as LiveReviewTutorialProps).anchors,
      )) {
        anchors.set(anchor.id, anchor);
      }
    } else if (element.type === "SequenceDiagram") {
      const messages = (element.props as SequenceDiagramProps).messages;
      for (const message of messages) {
        if (!message.anchor) continue;
        anchors.set(message.anchor.id, message.anchor);
        if (typeof message.code === "string") {
          anchorContents.set(message.anchor.id, message.code);
        } else if (message.code?.text) {
          anchorContents.set(message.anchor.id, message.code.text);
        }
      }
    }
  }
  return { anchors, anchorContents };
}
