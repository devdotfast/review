export const REVIEW_INTERACTION_EVENT = "review-interaction";

export type ReviewInteractionDetail =
  | { kind: "inline-hover"; path: string }
  | { kind: "inline-navigation"; path: string };

export function emitReviewInteraction(
  target: HTMLElement | null,
  detail: ReviewInteractionDetail,
): void {
  target?.dispatchEvent(
    new CustomEvent<ReviewInteractionDetail>(REVIEW_INTERACTION_EVENT, {
      bubbles: true,
      detail,
    }),
  );
}

export function reviewInteractionDetail(
  event: Event,
): ReviewInteractionDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<ReviewInteractionDetail> | undefined;
  if (detail?.kind !== "inline-hover" && detail?.kind !== "inline-navigation") {
    return null;
  }
  return typeof detail.path === "string"
    ? (detail as ReviewInteractionDetail)
    : null;
}
