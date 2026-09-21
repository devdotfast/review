/** Scroll `id` into view inside `article`, expanding the section holding it. */
export function scrollToReviewHeading(
  id: string,
  article: HTMLElement | null,
  scrollRegion: HTMLElement | null,
): void {
  const heading = article?.querySelector<HTMLElement>(`#${cssIdentifier(id)}`);

  if (!article || !heading) return;

  // Headings inside a collapsed section have no scroll position until
  // the section expands, so expand first and scroll on the next frame.
  // The jump is instant, like the tour feed's reveal: scroll-synced
  // highlighting reads the geometry after every scroll, and a smooth flight
  // would light up every heading passed on the way.
  const collapsedSection = heading.closest(".review-section--collapsed");
  collapsedSection?.dispatchEvent(new CustomEvent("review-section-expand"));

  const performScroll = () => {
    const scrollRoot = getReviewScrollRoot(article, scrollRegion);

    if (scrollRoot?.contains(heading)) {
      // Honor the heading's scroll-margin-top like scrollIntoView does, so
      // it lands a little below the edge instead of exactly on it.
      const scrollMargin =
        Number.parseFloat(window.getComputedStyle(heading).scrollMarginTop) ||
        0;

      scrollRoot.scrollTo({
        top:
          scrollRoot.scrollTop +
          heading.getBoundingClientRect().top -
          scrollRoot.getBoundingClientRect().top -
          scrollMargin,
        behavior: "auto",
      });
    } else {
      heading.scrollIntoView({ behavior: "auto", block: "start" });
    }
  };

  if (collapsedSection) {
    requestAnimationFrame(performScroll);
  } else {
    performScroll();
  }
}

export function getReviewScrollRoot(
  article: HTMLElement,
  scrollRegion: HTMLElement | null,
): HTMLElement | null {
  return scrollRegion ?? getNearestScrollableAncestor(article);
}

function getNearestScrollableAncestor(
  element: HTMLElement,
): HTMLElement | null {
  let current = element.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);

    if (
      current.scrollHeight > current.clientHeight &&
      isScrollableOverflow(style.overflowY, style.overflow)
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function isScrollableOverflow(overflowY: string, overflow: string): boolean {
  return (
    overflowY === "auto" ||
    overflowY === "scroll" ||
    overflowY === "overlay" ||
    overflow === "auto" ||
    overflow === "scroll" ||
    overflow === "overlay"
  );
}

export function cssIdentifier(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);

  return value.replace(/["\\]/g, "\\$&");
}
