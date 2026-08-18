import type {
  ReviewFindQuery,
  ReviewInlineEditorHandle,
} from "@dev.fast/review-protocol";
import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { compileReviewFindQuery } from "./review-find-query";
import { reviewFindRanges } from "./review-find-text";

const ALL_HIGHLIGHT = "review-find-match";
const ACTIVE_HIGHLIGHT = "review-find-match-active";

interface FindController {
  showFind(seed?: string): boolean;
  hideFind(): void;
}

export interface ReviewFindHost extends FindController {
  attach(controller: FindController | null): void;
}

export function createReviewFindHost(): ReviewFindHost {
  let controller: FindController | null = null;
  return {
    attach(next) {
      controller = next;
    },
    showFind(seed) {
      return controller?.showFind(seed) ?? false;
    },
    hideFind() {
      controller?.hideFind();
    },
  };
}

export interface ReviewInlineFindRegistration {
  container: HTMLElement;
  setFindQuery(query: ReviewFindQuery): Promise<{ matchCount: number }>;
  revealFindMatch(index: number): Promise<void>;
  clearFind(): void;
  getHandle(): ReviewInlineEditorHandle | null;
  expand(): void;
}

interface FindContextValue {
  register(registration: ReviewInlineFindRegistration): () => void;
  setReviewActive(active: boolean): void;
}

const ReviewFindContext = createContext<FindContextValue | null>(null);

export function useReviewFindRegistration(): FindContextValue | null {
  return useContext(ReviewFindContext);
}

type UnifiedMatch =
  | { kind: "mdx"; range: Range; node: Node }
  | {
      kind: "editor";
      registration: ReviewInlineFindRegistration;
      localIndex: number;
      node: Node;
    };

export function ReviewFindProvider({
  articleRef,
  scrollRegionRef,
  documentKey,
  host,
  children,
}: {
  articleRef: RefObject<HTMLElement | null>;
  scrollRegionRef: RefObject<HTMLElement | null>;
  documentKey: string;
  host?: ReviewFindHost;
  children: ReactNode;
}) {
  const registrations = useRef(new Set<ReviewInlineFindRegistration>());
  const [registrationVersion, setRegistrationVersion] = useState(0);
  const [open, setOpen] = useState(false);
  const [queryText, setQueryText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [searching, setSearching] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [matches, setMatches] = useState<UnifiedMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reviewActive = useRef(true);
  const generation = useRef(0);
  const priorFocus = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const matchesRef = useRef(matches);
  const activeIndexRef = useRef(activeIndex);
  matchesRef.current = matches;
  activeIndexRef.current = activeIndex;
  openRef.current = open;

  const clearHighlights = useCallback(() => {
    clearCssHighlights(articleRef.current?.ownerDocument);
    for (const registration of registrations.current) {
      registration.clearFind();
    }
  }, [articleRef]);

  const closeFind = useCallback(
    (restoreFocus: boolean) => {
      generation.current += 1;
      clearHighlights();
      setOpen(false);
      setSearching(false);
      setInvalid(null);
      setMatches([]);
      setActiveIndex(-1);
      const target = priorFocus.current;
      priorFocus.current = null;
      if (restoreFocus && target?.isConnected) target.focus();
    },
    [clearHighlights],
  );

  const hideFind = useCallback(() => closeFind(true), [closeFind]);

  const showFind = useCallback(
    (seed?: string) => {
      if (!reviewActive.current) return false;
      if (!openRef.current) {
        const active = articleRef.current?.ownerDocument.activeElement;
        priorFocus.current = active instanceof HTMLElement ? active : null;
        setOpen(true);
        const selected = seed ?? selectedMdxText(articleRef.current);
        if (selected) setQueryText(selected);
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return true;
    },
    [articleRef],
  );

  useEffect(() => {
    host?.attach({ showFind, hideFind });
    return () => host?.attach(null);
  }, [hideFind, host, showFind]);

  useEffect(() => {
    setQueryText("");
    hideFind();
  }, [documentKey]);

  useEffect(() => () => clearHighlights(), [clearHighlights]);

  const reveal = useCallback(
    (index: number, currentMatches = matchesRef.current) => {
      if (currentMatches.length === 0) return;
      const wrapped = (index + currentMatches.length) % currentMatches.length;
      const match = currentMatches[wrapped]!;
      setActiveIndex(wrapped);
      activeIndexRef.current = wrapped;
      clearActiveCssHighlight(articleRef.current?.ownerDocument);
      for (const registration of registrations.current) {
        registration.getHandle()?.clearActiveFindMatch();
      }
      if (match.kind === "mdx") {
        expandReviewSection(match.node);
        requestAnimationFrame(() => {
          setActiveCssHighlight(match.range);
          rangeElement(match.range)?.scrollIntoView?.({ block: "center" });
          inputRef.current?.focus();
        });
      } else {
        match.registration.expand();
        requestAnimationFrame(async () => {
          match.registration.container.scrollIntoView?.({ block: "center" });
          await match.registration.revealFindMatch(match.localIndex);
          inputRef.current?.focus();
        });
      }
    },
    [articleRef],
  );

  useEffect(() => {
    if (!open) return;
    const query: ReviewFindQuery = {
      text: queryText,
      matchCase,
      wholeWord,
      isRegex,
    };
    const currentGeneration = ++generation.current;
    if (!query.text) {
      clearHighlights();
      setSearching(false);
      setInvalid(null);
      setMatches([]);
      setActiveIndex(-1);
      return;
    }
    const compiled = compileReviewFindQuery(query);
    if ("error" in compiled) {
      setSearching(false);
      setInvalid(compiled.error);
      return;
    }
    clearHighlights();
    setInvalid(null);
    setSearching(true);
    const article = articleRef.current;
    const mdxMatches: UnifiedMatch[] = article
      ? reviewFindRanges(article, compiled.expression).map((range) => ({
          kind: "mdx" as const,
          range,
          node: range.startContainer,
        }))
      : [];
    const orderedRegistrations = [...registrations.current].sort(
      (left, right) => compareDocumentOrder(left.container, right.container),
    );
    void Promise.all(
      orderedRegistrations.map(async (registration) => {
        try {
          const result = await registration.setFindQuery({
            ...query,
            text: compiled.expression.source,
            wholeWord: false,
            isRegex: true,
          });
          return { registration, matchCount: result.matchCount };
        } catch {
          return { registration, matchCount: 0 };
        }
      }),
    ).then((editorResults) => {
      if (currentGeneration !== generation.current) return;
      const editorMatches: UnifiedMatch[] = editorResults.flatMap(
        ({ registration, matchCount }) =>
          Array.from({ length: matchCount }, (_, localIndex) => ({
            kind: "editor" as const,
            registration,
            localIndex,
            node: registration.container,
          })),
      );
      const combined = [...mdxMatches, ...editorMatches].sort((left, right) =>
        compareDocumentOrder(left.node, right.node),
      );
      setAllCssHighlights(
        article?.ownerDocument,
        mdxMatches
          .map((match) => (match.kind === "mdx" ? match.range : null))
          .filter((range): range is Range => range !== null),
      );
      setMatches(combined);
      matchesRef.current = combined;
      setSearching(false);
      if (combined.length > 0) reveal(0, combined);
      else setActiveIndex(-1);
    });
  }, [
    articleRef,
    clearHighlights,
    isRegex,
    matchCase,
    open,
    queryText,
    registrationVersion,
    reveal,
    wholeWord,
  ]);

  const context = useMemo<FindContextValue>(
    () => ({
      register(registration) {
        registrations.current.add(registration);
        setRegistrationVersion((value) => value + 1);
        return () => {
          registration.clearFind();
          registrations.current.delete(registration);
          setRegistrationVersion((value) => value + 1);
        };
      },
      setReviewActive(active) {
        reviewActive.current = active;
        if (!active && openRef.current) closeFind(false);
      },
    }),
    [closeFind],
  );

  const navigate = (delta: number) => {
    if (!searching && matches.length > 0) reveal(activeIndex + delta);
  };

  return (
    <ReviewFindContext.Provider value={context}>
      {children}
      {open ? (
        <div
          className="review-find-widget"
          role="search"
          aria-label="Find in Review"
        >
          <div className="review-find-input-shell">
            <input
              ref={inputRef}
              aria-label="Find"
              aria-invalid={invalid ? "true" : undefined}
              title={invalid ?? undefined}
              value={queryText}
              onChange={(event) => setQueryText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  hideFind();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  navigate(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <div className="review-find-options" aria-label="Search options">
              <FindToggle
                label="Match Case"
                description="Match Case: use the same uppercase and lowercase letters."
                active={matchCase}
                onClick={() => setMatchCase((value) => !value)}
              >
                Aa
              </FindToggle>
              <FindToggle
                label="Match Whole Word"
                description="Match Whole Word: find complete words only."
                className="review-find-toggle--whole-word"
                active={wholeWord}
                onClick={() => setWholeWord((value) => !value)}
              >
                ab
              </FindToggle>
              <FindToggle
                label="Use Regular Expression"
                description="Use Regular Expression: search with a regular expression."
                className="review-find-toggle--regex"
                active={isRegex}
                onClick={() => setIsRegex((value) => !value)}
              >
                .*
              </FindToggle>
            </div>
          </div>
          <span className="review-find-count" aria-live="polite">
            {invalid
              ? "Invalid expression"
              : searching
                ? "Searching…"
                : matches.length === 0
                  ? "No results"
                  : `${activeIndex + 1} of ${matches.length}`}
          </span>
          <FindActionButton
            label="Previous Match"
            description="Previous Match (Shift+Enter)"
            disabled={searching || matches.length === 0}
            onClick={() => navigate(-1)}
            icon="previous"
          />
          <FindActionButton
            label="Next Match"
            description="Next Match (Enter)"
            disabled={searching || matches.length === 0}
            onClick={() => navigate(1)}
            icon="next"
          />
          <FindActionButton
            label="Close Find"
            description="Close Find (Escape)"
            onClick={hideFind}
            icon="close"
          />
        </div>
      ) : null}
    </ReviewFindContext.Provider>
  );
}

function FindToggle({
  label,
  description,
  className,
  active,
  onClick,
  children,
}: {
  label: string;
  description: string;
  className?: string;
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={active}
      title={description}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FindActionButton({
  label,
  description,
  disabled,
  onClick,
  icon,
}: {
  label: string;
  description: string;
  disabled?: boolean;
  onClick(): void;
  icon: "previous" | "next" | "close";
}) {
  return (
    <button
      type="button"
      className="review-find-action"
      aria-label={label}
      title={description}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <FindActionIcon icon={icon} />
    </button>
  );
}

function FindActionIcon({ icon }: { icon: "previous" | "next" | "close" }) {
  const path =
    icon === "previous"
      ? "M3 7.5 8 2.5l5 5M8 3v10.5"
      : icon === "next"
        ? "m3 8.5 5 5 5-5M8 13V2.5"
        : "m3 3 10 10M13 3 3 13";
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function selectedMdxText(article: HTMLElement | null): string | undefined {
  const selection = article?.ownerDocument.getSelection();
  if (!article || !selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.commonAncestorContainer)) return undefined;
  return selection.toString().trim() || undefined;
}

function expandReviewSection(node: Node): void {
  const element = node instanceof Element ? node : node.parentElement;
  element
    ?.closest(".review-section--collapsed")
    ?.dispatchEvent(new CustomEvent("review-section-expand"));
}

function rangeElement(range: Range): Element | null {
  return range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement;
}

function compareDocumentOrder(left: Node, right: Node): number {
  if (left === right) return 0;
  const position = left.compareDocumentPosition(right);
  return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(document: Document | null | undefined): {
  registry: HighlightRegistry;
  Highlight: new (...ranges: Range[]) => unknown;
} | null {
  const view = document?.defaultView as
    | (Window & {
        CSS?: { highlights?: HighlightRegistry };
        Highlight?: new (...ranges: Range[]) => unknown;
      })
    | null;
  const registry = view?.CSS?.highlights;
  return registry && view?.Highlight
    ? { registry, Highlight: view.Highlight }
    : null;
}

function setAllCssHighlights(
  document: Document | undefined,
  ranges: Range[],
): void {
  const api = highlightApi(document);
  if (!api) return;
  api.registry.set(ALL_HIGHLIGHT, new api.Highlight(...ranges));
}

function setActiveCssHighlight(range: Range): void {
  const api = highlightApi(range.startContainer.ownerDocument);
  if (!api) return;
  api.registry.set(ACTIVE_HIGHLIGHT, new api.Highlight(range));
}

function clearActiveCssHighlight(document: Document | undefined): void {
  highlightApi(document)?.registry.delete(ACTIVE_HIGHLIGHT);
}

function clearCssHighlights(document: Document | undefined): void {
  const registry = highlightApi(document)?.registry;
  registry?.delete(ALL_HIGHLIGHT);
  registry?.delete(ACTIVE_HIGHLIGHT);
}
