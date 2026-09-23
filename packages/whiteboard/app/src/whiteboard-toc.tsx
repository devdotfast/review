import { type ReactElement, useEffect, useState } from "react";

import { ContentsIcon } from "./icons";
import {
  activeTargetForScroll,
  scrollTailHeight,
} from "./scroll-active-tracking";
import type { WhiteboardTocEntry } from "./whiteboard-document-headings";
import {
  cssIdentifier,
  getWhiteboardScrollRoot,
  scrollToWhiteboardHeading,
} from "./whiteboard-heading-scroll";
import { useWhiteboardRoots } from "./whiteboard-root-context";

interface NumberedWhiteboardTocEntry extends WhiteboardTocEntry {
  number: string;
}

/**
 * Narrowest shell that fits the rail beside the prose: the 720px prose
 * measure sits centered, so each gutter is (shell - 720) / 2, and the rail
 * needs left offset (24) + card (up to ~286 with padding) + breathing room
 * before the text starts — a ~320px gutter, so a 1360px shell.
 */
const TOC_RAIL_MIN_SHELL_WIDTH = 1360;

/**
 * Room to leave above the last heading once it is scrolled to the top, so
 * the tail spacer is no larger than it needs to be. Mirrors the tour feed.
 */
const TAIL_TOP_SLACK_PX = 24;

/** CSS custom property the scroll region reads for its tail padding. */
const TAIL_CSS_PROPERTY = "--whiteboard-toc-tail";

export function WhiteboardToc({
  entries,
}: {
  entries: readonly WhiteboardTocEntry[];
}): ReactElement | null {
  const roots = useWhiteboardRoots();
  const shellRef = roots?.shellRef;
  const scrollRegionRef = roots?.scrollRegionRef;
  const articleRef = roots?.articleRef;
  const [active, setActive] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isWide, setIsWide] = useState(false);

  // A wide shell keeps the rail beside the prose for the whole document; the
  // rail sits outside the scroll region, so it stays put while the reader
  // scrolls and only the active underline moves. When the shell narrows
  // (small window or open side panel), collapse to the breadcrumb pill.
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

  useEffect(() => {
    if (isWide) setIsDrawerOpen(false);
  }, [isWide]);

  useEffect(() => {
    if (!isDrawerOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Node)) return;

      if (target instanceof Element && target.closest(".whiteboard-toc"))
        return;

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
    // The highlight follows the shared scroll-tracking rule (see
    // scroll-active-tracking.ts), the same one the tour feed uses, so a
    // click's instant jump lands on its entry without lighting up the ones
    // in between.
    const visibleHeadings = (article: HTMLElement) =>
      entries
        .flatMap((entry) => {
          const heading = article.querySelector<HTMLElement>(
            `#${cssIdentifier(entry.id)}`,
          );

          return heading ? [heading] : [];
        })
        .filter(isVisibleHeadingForActiveTracking);

    const updateActiveHeading = () => {
      const article = articleRef?.current;

      if (!article) return;
      const headings = visibleHeadings(article);

      const scrollRoot = getWhiteboardScrollRoot(
        article,
        scrollRegionRef?.current ?? null,
      );

      const rootRect = scrollRoot?.getBoundingClientRect();
      const scrollerTop = rootRect?.top ?? 0;

      const halfLine = rootRect
        ? rootRect.top + rootRect.height / 2
        : window.innerHeight / 2;

      const nextActive = activeTargetForScroll(
        headings.map((heading) => ({
          id: heading.id,
          top: heading.getBoundingClientRect().top,
        })),
        scrollerTop,
        halfLine,
      );

      if (nextActive !== null) setActive(nextActive);
    };

    // The last heading can only reach the top edge if the scroll region has
    // room below it: the region reads this tail as extra bottom padding.
    const updateTail = () => {
      const article = articleRef?.current;
      const scrollRoot = scrollRegionRef?.current;

      if (!article || !scrollRoot) return;
      const lastHeading = visibleHeadings(article).at(-1);

      if (!lastHeading) return;

      const currentTail = Number.parseFloat(
        scrollRoot.style.getPropertyValue(TAIL_CSS_PROPERTY) || "0",
      );

      const lastTargetTop =
        lastHeading.getBoundingClientRect().top -
        scrollRoot.getBoundingClientRect().top +
        scrollRoot.scrollTop;

      const tail = scrollTailHeight({
        lastTargetTop,
        slack: TAIL_TOP_SLACK_PX,
        viewportHeight: scrollRoot.clientHeight,
        contentHeightSansTail: scrollRoot.scrollHeight - currentTail,
      });

      if (tail !== currentTail) {
        scrollRoot.style.setProperty(TAIL_CSS_PROPERTY, `${tail}px`);
      }
    };

    let frame: number | null = null;

    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        updateActiveHeading();
      });
    };

    let tailFrame: number | null = null;

    const scheduleTail = () => {
      if (tailFrame !== null) return;
      tailFrame = requestAnimationFrame(() => {
        tailFrame = null;
        updateTail();
        updateActiveHeading();
      });
    };

    document.addEventListener("scroll", scheduleUpdate, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", scheduleTail);
    updateTail();
    updateActiveHeading();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleTail);

    const scrollRoot = scrollRegionRef?.current;
    const article = articleRef?.current;

    if (resizeObserver && scrollRoot) resizeObserver.observe(scrollRoot);

    if (resizeObserver && article) resizeObserver.observe(article);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);

      if (tailFrame !== null) cancelAnimationFrame(tailFrame);
      resizeObserver?.disconnect();
      scrollRegionRef?.current?.style.removeProperty(TAIL_CSS_PROPERTY);
      document.removeEventListener("scroll", scheduleUpdate, {
        capture: true,
      });
      window.removeEventListener("resize", scheduleTail);
    };
  }, [articleRef, entries, scrollRegionRef]);

  if (entries.length < 2) return null;

  const scrollTo = (id: string) => {
    scrollToWhiteboardHeading(
      id,
      articleRef?.current ?? null,
      scrollRegionRef?.current ?? null,
    );
    setActive(id);
    setIsDrawerOpen(false);
  };

  const numberedEntries = numberWhiteboardTocEntries(entries);

  const showRail = isWide;
  const showList = showRail || isDrawerOpen;

  // On a narrow shell the nav is the pill: a 32px square holding only the
  // contents glyph, anchored where the pill has always sat. Opening does not
  // summon a second card; the same box grows in place, its top-left corner
  // pinned and the glyph still in it, until it is the contents card. The rail
  // on a wide shell is the same nav without the button.
  return (
    <nav
      id="whiteboard-toc"
      className={
        (showRail ? "whiteboard-toc whiteboard-toc--rail" : "whiteboard-toc") +
        (showList ? " whiteboard-toc--open" : "")
      }
      aria-label="Contents"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsDrawerOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="whiteboard-toc-toggle"
        aria-label={isDrawerOpen ? "Close contents" : "Open contents"}
        aria-expanded={isDrawerOpen}
        aria-controls="whiteboard-toc-body"
        hidden={showRail || undefined}
        onClick={() => setIsDrawerOpen((open) => !open)}
      >
        <ContentsIcon />
      </button>
      <div id="whiteboard-toc-body" className="whiteboard-toc-body">
        <div className="whiteboard-toc-head">Contents</div>
        <ul className="whiteboard-toc-list">
          {numberedEntries.map((entry) => (
            <li
              key={entry.id}
              className={
                `whiteboard-toc-item whiteboard-toc-item--${entry.level}` +
                (active === entry.id ? " whiteboard-toc-item--active" : "")
              }
            >
              <button
                type="button"
                className="whiteboard-toc-link"
                onClick={() => scrollTo(entry.id)}
              >
                <span className="whiteboard-toc-number">{entry.number}</span>
                <span className="whiteboard-toc-text">{entry.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function numberWhiteboardTocEntries(
  entries: readonly WhiteboardTocEntry[],
): NumberedWhiteboardTocEntry[] {
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
