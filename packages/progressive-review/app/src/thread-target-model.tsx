import {
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { type AnchorRef, throwAuthoringIssue } from "../../src/authoring";
import type { ThreadTarget } from "../../src/types";
import { useReviewSession } from "./host/review-session";
import { reviewDocumentText } from "./review-document-text";
import { useReviewInitialData } from "./review-initial-data-context";
import { useReviewRoots } from "./review-root-context";
import {
  type LiveAnchorTarget,
  type LiveDiagramTarget,
  type LiveThreadTargetModel,
  type ThreadTargetState,
  resolveTargetState,
} from "./thread-target-state";

interface DiagramRegistry {
  register(owner: string, diagram: LiveDiagramTarget): void;
  unregister(owner: string): void;
  publish(): void;
  subscribe(listener: () => void): () => void;
  version(): number;
  diagrams(): ReadonlyMap<string, LiveDiagramTarget>;
}

const DiagramRegistryContext = createContext<DiagramRegistry | null>(null);
const EMPTY_DIAGRAMS = new Map<string, LiveDiagramTarget>();
const LiveAnchorsContext = createContext<ReadonlyMap<string, LiveAnchorTarget>>(
  new Map(),
);
const ResolvedBaseRefContext = createContext<string | null>(null);
const ResolvedHeadRefContext = createContext<string | null>(null);

export function ThreadTargetModelProvider({
  anchors,
  anchorContents,
  documentRoute,
  children,
}: {
  anchors: ReadonlyMap<string, AnchorRef>;
  anchorContents: ReadonlyMap<string, string>;
  documentRoute?: string;
  children?: ReactNode;
}): ReactElement {
  const registry = useMemo(createDiagramRegistry, [anchorContents, anchors]);
  const liveAnchors = useMemo(
    () => buildLiveAnchors(anchors, anchorContents),
    [anchorContents, anchors],
  );
  // Session facts travel the data plane, not the build plane: a virtual-module
  // field is frozen at plugin boot and goes stale when server code changes
  // under a live session, while a fetch always reflects the running server.
  const resolvedRefs = useReviewSessionRefs(documentRoute);
  return (
    <ResolvedBaseRefContext.Provider value={resolvedRefs.base}>
      <ResolvedHeadRefContext.Provider value={resolvedRefs.head}>
        <LiveAnchorsContext.Provider value={liveAnchors}>
          <DiagramRegistryContext.Provider value={registry}>
            {children}
          </DiagramRegistryContext.Provider>
        </LiveAnchorsContext.Provider>
      </ResolvedHeadRefContext.Provider>
    </ResolvedBaseRefContext.Provider>
  );
}

function useReviewSessionRefs(documentRoute?: string): {
  base: string | null;
  head: string | null;
} {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const initialResolvedBaseRef = useReviewInitialData()?.sessionResolvedBaseRef;
  const [resolvedRefs, setResolvedRefs] = useState(() => ({
    base: initialResolvedBaseRef ?? null,
    head: null as string | null,
  }));
  useEffect(() => {
    if (typeof fetch === "undefined") return;
    let disposed = false;
    void reviewFetch("/session", {}, { routePath: documentRoute })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Review session request failed (${response.status}).`,
          );
        }
        const body = (await response.json()) as {
          session?: { resolvedBaseRef?: string | null; headRef?: string };
        };
        if (!disposed) {
          setResolvedRefs({
            base: body.session?.resolvedBaseRef ?? null,
            head: body.session?.headRef ?? null,
          });
        }
      })
      .catch((error: unknown) => {
        // Base-side comment creation guards on the missing value with its own
        // explicit error; log the fetch failure rather than swallowing it.
        console.error(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    return () => {
      disposed = true;
    };
  }, [documentRoute, reviewFetch]);
  return resolvedRefs;
}

export function useRegisterLiveDiagram(
  diagram: LiveDiagramTarget | null,
): void {
  const registry = useContext(DiagramRegistryContext);
  const owner = useId();
  if (diagram) registry?.register(owner, diagram);
  useLayoutEffect(() => {
    registry?.publish();
  });
  useLayoutEffect(() => {
    return () => {
      registry?.unregister(owner);
      registry?.publish();
    };
  }, [owner, registry]);
}

export function useLiveDiagrams(): ReadonlyMap<string, LiveDiagramTarget> {
  const registry = useContext(DiagramRegistryContext);
  useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.version ?? zeroVersion,
    registry?.version ?? zeroVersion,
  );
  return registry?.diagrams() ?? EMPTY_DIAGRAMS;
}

export function useLiveAnchors(): ReadonlyMap<string, LiveAnchorTarget> {
  return useContext(LiveAnchorsContext);
}

export function useResolvedBaseRef(): string | null {
  return useContext(ResolvedBaseRefContext);
}

export function useResolvedHeadRef(): string | null {
  return useContext(ResolvedHeadRefContext);
}

export function useThreadTargetState(target: ThreadTarget): ThreadTargetState {
  const diagrams = useLiveDiagrams();
  const anchors = useContext(LiveAnchorsContext);
  const article = useReviewRoots()?.articleRef.current ?? null;
  return resolveTargetState(
    { target },
    buildLiveThreadTargetModel(article, anchors, diagrams),
  );
}

export function buildLiveThreadTargetModel(
  article: HTMLElement | null,
  anchors: ReadonlyMap<string, LiveAnchorTarget>,
  diagrams: ReadonlyMap<string, LiveDiagramTarget>,
): LiveThreadTargetModel {
  const blocks = article
    ? [
        ...article.querySelectorAll<HTMLElement>("[data-review-block-index]"),
      ].map((element) => ({
        tag: element.dataset.reviewBlockTag ?? element.tagName.toLowerCase(),
        index: requiredDatasetInteger(element, "reviewBlockIndex"),
        text: element.textContent ?? "",
      }))
    : [];
  const tableCells = article
    ? [...article.querySelectorAll<HTMLElement>("[data-review-table]")].map(
        (element) => ({
          table: requiredDatasetInteger(element, "reviewTable"),
          row: requiredDatasetInteger(element, "reviewRow"),
          column: requiredDatasetInteger(element, "reviewColumn"),
          text: element.textContent ?? "",
        }),
      )
    : [];
  return {
    documentText: article ? reviewDocumentText(article) : null,
    blocks,
    tableCells,
    anchors,
    diagrams,
  };
}

function createDiagramRegistry(): DiagramRegistry {
  const byOwner = new Map<string, LiveDiagramTarget>();
  const listeners = new Set<() => void>();
  let currentVersion = 0;
  return {
    register(owner, diagram) {
      const previous = byOwner.get(owner);
      if (previous?.label !== diagram.label) byOwner.delete(owner);
      const duplicate = [...byOwner.entries()].find(
        ([candidateOwner, candidate]) =>
          candidateOwner !== owner && candidate.label === diagram.label,
      );
      if (duplicate) {
        throwAuthoringIssue(
          ["diagrams", "label"],
          `Diagram label "${diagram.label}" is used more than once in this document`,
        );
      }
      byOwner.set(owner, diagram);
    },
    unregister(owner) {
      byOwner.delete(owner);
    },
    publish() {
      currentVersion += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => currentVersion,
    diagrams() {
      return new Map(
        [...byOwner.values()].map((diagram) => [diagram.label, diagram]),
      );
    },
  };
}

function buildLiveAnchors(
  anchors: ReadonlyMap<string, AnchorRef>,
  anchorContents: ReadonlyMap<string, string>,
): ReadonlyMap<string, LiveAnchorTarget> {
  return new Map(
    [...anchors.values()].map((anchor) => {
      const contentText = anchorContents.get(anchor.id);
      return [
        anchor.id,
        {
          anchorId: anchor.id,
          title: anchor.title,
          detail: anchor.detail,
          ...(contentText !== undefined
            ? { content: { text: contentText } }
            : {}),
        },
      ];
    }),
  );
}

function requiredDatasetInteger(
  element: HTMLElement,
  key: keyof DOMStringMap,
): number {
  const value = Number(element.dataset[key]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Review target stamp ${String(key)} must be a non-negative integer.`,
    );
  }
  return value;
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

function zeroVersion(): number {
  return 0;
}
