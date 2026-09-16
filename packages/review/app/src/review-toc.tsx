import { type ReactElement, useEffect, useState } from "react";

import { ContentsIcon } from "./icons";
import type { ReviewTocEntry } from "./review-document-headings";
import {
  cssIdentifier,
  getReviewScrollRoot,
  scrollToReviewHeading,
} from "./review-heading-scroll";
import { useReviewRoots } from "./review-root-context";

interface NumberedReviewTocEntry extends ReviewTocEntry {
  number: string;
}

/** Scroll offset past which the rail collapses into the breadcrumb pill. */
const TOC_COLLAPSE_SCROLL_TOP = 48;

/**
 * Narrowest shell that fits the rail beside the prose: the 720px prose
 * measure sits centered, so each gutter is (shell - 720) / 2, and the rail
 * needs left offset (24) + card (up to ~286 with padding) + breathing room
 * before the text starts — a ~320px gutter, so a 1360px shell.
 */
const TOC_RAIL_MIN_SHELL_WIDTH = 1360;

/** How far below the scroll viewport's top edge a heading counts as reached. */
const ACTIVE_HEADING_TOP_SLACK_PX = 24;

export function ReviewToc({
  entries,
}: {
  entries: readonly ReviewTocEntry[];
}): ReactElement | null {
  const roots = useReviewRoots();
  const shellRef = roots?.shellRef;
  const scrollRegionRef = roots?.scrollRegionRef;
  const articleRef = roots?.articleRef;
  const [active, setActive] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isWide, setIsWide] = useState(false);

  // The rail shows only at the top of a wide shell; when the shell narrows
  // (small window or open side panel), collapse to the pill even at the top
  // of the document.
  useEffect(() => {
    const shell = shellRef?.current;

    if (!shell) return;

    const updateWidth = () => {
      setIsWide(shell.clientWidth >= TOC_RAIL_MIN_SHELL_WIDTH);
    };

    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(shell);

    return () => resizeObserver.disconnect();
  }, [shellRef]);

  // Listen at the document level (capture) and re-query the region per event
  // so MDX hydration/HMR swapping the scroll root can't strand the listener
  // on a detached node.
  useEffect(() => {
    const updateScrolled = () => {
      const scrollRoot = scrollRegionRef?.current;

      if (!scrollRoot) return;
      setIsScrolled(scrollRoot.scrollTop > TOC_COLLAPSE_SCROLL_TOP);
    };

    updateScrolled();
    document.addEventListener("scroll", updateScrolled, {
      passive: true,
      capture: true,
    });

    return () => {
      document.removeEventListener("scroll", updateScrolled, {
        capture: true,
      });
    };
  }, [scrollRegionRef]);

  useEffect(() => {
    if (!isScrolled) setIsDrawerOpen(false);
  }, [isScrolled]);

  useEffect(() => {
    if (!isDrawerOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Node)) return;

      if (target instanceof Element && target.closest(".review-toc")) return;

      if (target instanceof Element && target.closest(".review-toc-toggle")) {
        return;
      }

      setIsDrawerOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
    };
  }, [isDrawerOpen]);

  useEffect(() => {
    setActive((current) =>
      entries.some((entry) => entry.id === current)
        ? current
        : (entries[0]?.id ?? null),
    );
  }, [entries]);

  useEffect(() => {
    if (entries.length < 2) {
      setActive(null);

      return;
    }

    // Entries are stable across MDX hydration and HMR remounts (same ids), so
    // this effect may never re-run after the document/scroll-root nodes are
    // replaced. Re-query on every update — and listen in capture phase at the
    // document level — so the tracking never binds to detached nodes.
    // A section stays active until the next heading reaches the top edge of
    // the scroll viewport, so the highlight/pill always name the section
    // whose body is under the reader.
    const updateActiveHeading = () => {
      const article = articleRef?.current;

      if (!article) return;

      const headings = entries
        .flatMap((entry) => {
          const heading = article.querySelector<HTMLElement>(
            `#${cssIdentifier(entry.id)}`,
          );

          return heading ? [heading] : [];
        })
        .filter(isVisibleHeadingForActiveTracking);

      const firstHeading = headings[0];

      if (!firstHeading) return;

      const activeLine = getScrollRootActiveLine(
        getReviewScrollRoot(article, scrollRegionRef?.current ?? null),
      );

      let nextActive = firstHeading;

      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= activeLine) {
          nextActive = heading;
        } else {
          break;
        }
      }

      setActive(nextActive.id);
    };

    let frame: number | null = null;

    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        updateActiveHeading();
      });
    };

    document.addEventListener("scroll", scheduleUpdate, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", scheduleUpdate);
    updateActiveHeading();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scheduleUpdate, {
        capture: true,
      });
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [articleRef, entries, scrollRegionRef]);

  if (entries.length < 2) return null;

  const scrollTo = (id: string) => {
    scrollToReviewHeading(
      id,
      articleRef?.current ?? null,
      scrollRegionRef?.current ?? null,
    );
    setActive(id);
    setIsDrawerOpen(false);
  };

  const numberedEntries = numberReviewTocEntries(entries);

  const activeEntry =
    numberedEntries.find((entry) => entry.id === active) ?? numberedEntries[0];

  const showRail = !isScrolled && isWide;
  const showList = showRail || isDrawerOpen;

  return (
    <>
      <button
        type="button"
        className={
          isDrawerOpen
            ? "review-toc-toggle review-toc-toggle--active"
            : "review-toc-toggle"
        }
        aria-label={isDrawerOpen ? "Close contents" : "Open contents"}
        aria-expanded={isDrawerOpen}
        aria-controls="review-toc"
        hidden={showRail || undefined}
        onClick={() => setIsDrawerOpen((open) => !open)}
      >
        <ContentsIcon />
        {activeEntry && (
          <>
            <span className="review-toc-toggle-number">
              {activeEntry.number}
            </span>
            <strong className="review-toc-toggle-title">
              {activeEntry.text}
            </strong>
          </>
        )}
      </button>
      <nav
        id="review-toc"
        className={
          (showRail ? "review-toc review-toc--rail" : "review-toc") +
          (showList ? " review-toc--open" : "")
        }
        aria-label="Contents"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setIsDrawerOpen(false);
          }
        }}
      >
        <div className="review-toc-head">Contents</div>
        <ul className="review-toc-list">
          {numberedEntries.map((entry) => (
            <li
              key={entry.id}
              className={
                `review-toc-item review-toc-item--${entry.level}` +
                (active === entry.id ? " review-toc-item--active" : "")
              }
            >
              <button
                type="button"
                className="review-toc-link"
                onClick={() => scrollTo(entry.id)}
              >
                <span className="review-toc-number">{entry.number}</span>
                <span className="review-toc-text">{entry.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function numberReviewTocEntries(
  entries: readonly ReviewTocEntry[],
): NumberedReviewTocEntry[] {
  let sectionIndex = 0;
  let subsectionIndex = 0;

  return entries.map((entry) => {
    if (entry.level === "h2") {
      sectionIndex += 1;
      subsectionIndex = 0;

      return { ...entry, number: `${sectionIndex}` };
    }

    subsectionIndex += 1;

    return {
      ...entry,
      number: `${sectionIndex}.${subsectionIndex}`,
    };
  });
}

function isVisibleHeadingForActiveTracking(heading: HTMLElement): boolean {
  if (heading.closest("[hidden]")) return false;
  const rect = heading.getBoundingClientRect();

  return rect.width !== 0 || rect.height !== 0;
}

function getScrollRootActiveLine(scrollRoot: HTMLElement | null): number {
  if (!scrollRoot) return ACTIVE_HEADING_TOP_SLACK_PX;

  return scrollRoot.getBoundingClientRect().top + ACTIVE_HEADING_TOP_SLACK_PX;
}
