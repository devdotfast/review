import type { ReviewAuthoringTarget } from "@dev.fast/review-protocol";
import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer, defineRegistry } from "@json-render/react";
import {
  type ReactNode,
  createContext,
  createElement,
  useContext,
} from "react";

import {
  type ActorRef,
  type AnchorRef,
  type AuthoredTargetRef,
  type SequenceDiagramProps,
  type StoreRef,
  createReviewDefinitionSession,
} from "../../src/authoring";
import { liveReviewCatalog } from "../../src/live-review-catalog";
import type {
  LiveDatabaseLensProps,
  LiveReviewCodePeekProps,
  LiveReviewMarkdownProps,
  LiveReviewTutorialProps,
} from "../../src/live-review-catalog";
import type { LiveReviewPage } from "../../src/live-review-types";
import { MarkdownContent } from "./agent-markdown";
import { ReviewCodePeek } from "./CodePeek";
import { DatabaseLens, DbRead, DbUseCase, DbWrite } from "./database-lens";
import { SequenceDiagram } from "./diagrams";
import { LiveTutorialDocument } from "./live-tutorial-document";
import { AnchorLink, ReviewSection } from "./review-components";
import { ReviewDocumentMetaLine } from "./review-doc-meta";
import type { ReadyReviewDocumentEntry } from "./review-document";
import { useActiveReviewDocument } from "./review-document-context";
import { TraceQuote } from "./trace-quote";

const { registry } = defineRegistry(liveReviewCatalog, {
  components: {
    ReviewNode: ({ props, children }) => (
      <ReviewNode nodeId={props.nodeId} depth={props.depth} title={props.title}>
        {children}
      </ReviewNode>
    ),
    Markdown: ({ props }) => (
      <LiveMarkdown {...(props as LiveReviewMarkdownProps)} />
    ),
    CodePeek: ({ props }) => (
      <ReviewCodePeek anchor={(props as LiveReviewCodePeekProps).anchor} />
    ),
    SequenceDiagram: ({ props }) => (
      <SequenceDiagram {...(props as SequenceDiagramProps)} />
    ),
    DatabaseLens: ({ props }) => (
      <LiveDatabaseLens {...(props as LiveDatabaseLensProps)} />
    ),
    Tutorial: ({ props }) => (
      <LiveTutorialDocument {...(props as LiveReviewTutorialProps)} />
    ),
  },
});

function LiveMarkdown(props: LiveReviewMarkdownProps) {
  return (
    <MarkdownContent
      source={props.source}
      renderLink={({ href, children }) => {
        const key = href.startsWith("#review-inline-")
          ? href.slice("#review-inline-".length)
          : null;
        const link = key ? props.links?.[key] : undefined;
        if (!link) return undefined;
        return link.kind === "anchor" ? (
          <AnchorLink anchor={link.anchor}>{children}</AnchorLink>
        ) : (
          <TraceQuote
            sessionId={link.sessionId}
            trace={link.trace}
            event={link.event}
          >
            {children}
          </TraceQuote>
        );
      }}
    />
  );
}

function LiveDatabaseLens(props: LiveDatabaseLensProps) {
  const definitions = createReviewDefinitionSession({
    softwareMap: null,
    baseSoftwareMap: null,
  });
  const stores = definitions.defineStores(props.stores);
  return (
    <DatabaseLens title={props.title} stores={stores} height={props.height}>
      {props.useCases.map((useCase) => (
        <DbUseCase
          key={useCase.id}
          id={useCase.id}
          label={useCase.label}
          summary={useCase.summary}
        >
          {useCase.operations.map((operation, index) => {
            const actor: ActorRef = {
              __kind: "db-actor-ref",
              id: operation.actor.id,
              label: operation.actor.label,
            };
            const target = liveDatabaseTarget(stores, operation.target);
            return operation.kind === "read" ? (
              <DbRead
                key={`${useCase.id}-${index}`}
                from={target}
                to={actor}
                label={operation.label}
                anchor={operation.anchor}
              />
            ) : (
              <DbWrite
                key={`${useCase.id}-${index}`}
                from={actor}
                to={target}
                label={operation.label}
                anchor={operation.anchor}
              />
            );
          })}
        </DbUseCase>
      ))}
    </DatabaseLens>
  );
}

function liveDatabaseTarget(
  stores: Record<string, StoreRef>,
  target: LiveDatabaseLensProps["useCases"][number]["operations"][number]["target"],
): AuthoredTargetRef {
  let current: unknown =
    stores[target.store]?.[target.collectionKind]?.[target.collection];
  for (const segment of target.path) {
    current = (current as Record<string, unknown> | undefined)?.[segment];
  }
  if (!current) {
    throw new Error(
      `Database target does not exist: ${target.store}.${target.collectionKind}.${target.collection}.${target.path.join(".")}`,
    );
  }
  return current as AuthoredTargetRef;
}

export const LiveReviewAuthoringTargetContext =
  createContext<ReviewAuthoringTarget | null>(null);

export function ReviewNode({
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
  const authoringTarget = useContext(LiveReviewAuthoringTargetContext);
  const isExactTarget = authoringTarget?.targetNodeId === nodeId;
  const isTargetSection =
    depth === 1 && authoringTarget?.sectionNodeId === nodeId;
  const isActiveContainer = isTargetSection || (depth === 0 && isExactTarget);
  const className = [
    "review-live-node",
    depth === 0 ? "review-live-node--root" : undefined,
    isActiveContainer ? "review-live-node--authoring-active" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const authoringAttributes = {
    "data-review-node-id": nodeId,
    ...(isExactTarget ? { "data-review-authoring-target": "true" } : {}),
  };
  if (depth === 0) {
    return (
      <div className={className} {...authoringAttributes}>
        {title && <h1>{title}</h1>}
        {title && <ReviewDocumentMetaLine />}
        {children}
      </div>
    );
  }
  if (depth === 1 && title) {
    return (
      <div className={className} {...authoringAttributes}>
        <ReviewSection title={title}>
          <h2>{title}</h2>
          {children}
        </ReviewSection>
      </div>
    );
  }
  return (
    <div className={className} {...authoringAttributes}>
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
    } else if (element.type === "Markdown") {
      const links = (element.props as LiveReviewMarkdownProps).links;
      for (const link of Object.values(links ?? {})) {
        if (link.kind === "anchor") anchors.set(link.anchor.id, link.anchor);
      }
    } else if (element.type === "CodePeek") {
      const anchor = (element.props as LiveReviewCodePeekProps).anchor;
      anchors.set(anchor.id, anchor);
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
    } else if (element.type === "DatabaseLens") {
      const useCases = (element.props as LiveDatabaseLensProps).useCases;
      for (const useCase of useCases) {
        for (const operation of useCase.operations) {
          anchors.set(operation.anchor.id, operation.anchor);
        }
      }
    }
  }
  return { anchors, anchorContents };
}
