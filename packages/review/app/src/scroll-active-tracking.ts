/**
 * Scroll-synced highlighting shared by the tour feed and the contents rail.
 * Both list anchored targets in reading order and want the same answers:
 * which target is being read at the current scroll position, and how much
 * tail room the scroller needs so the last target can be reached at all.
 */

export interface ScrollTrackedTarget {
  id: string;
  /** Viewport-relative top edge, as `getBoundingClientRect().top`. */
  top: number;
}

/**
 * Docusaurus's TOC rule: the first target whose top is still below the
 * scroller's top edge is the candidate. Once it reaches the top half of the
 * viewport it takes the highlight; until then the previous target keeps it.
 * Past every target, the last one holds. The look-ahead protects the top
 * edge structurally: at scroll zero the candidate is the first target, no
 * matter how short it is.
 *
 * Because the answer depends only on the current geometry, an instant
 * (non-smooth) programmatic scroll lands on the intended target without the
 * highlight visiting the ones in between.
 */
export function activeTargetForScroll(
  targets: readonly ScrollTrackedTarget[],
  scrollerTop: number,
  halfLine: number,
): string | null {
  const last = targets[targets.length - 1];

  if (!last) return null;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;

    if (target.top < scrollerTop) continue;

    return target.top <= halfLine
      ? target.id
      : (targets[index - 1] ?? target).id;
  }

  return last.id;
}

/**
 * Height of the spacer that lets the last target scroll up to the active
 * line. `lastTargetTop` is measured in content coordinates (viewport top of
 * the target minus the scroller's viewport top, plus `scrollTop`), and
 * `contentHeightSansTail` is the scroll height without the current spacer.
 */
export function scrollTailHeight({
  lastTargetTop,
  slack,
  viewportHeight,
  contentHeightSansTail,
}: {
  lastTargetTop: number;
  slack: number;
  viewportHeight: number;
  contentHeightSansTail: number;
}): number {
  return Math.max(
    0,
    Math.ceil(lastTargetTop - slack + viewportHeight - contentHeightSansTail),
  );
}
