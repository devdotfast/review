import { type RefObject, useEffect } from "react";

/** Embedded content is scrolled with its scrollbars; wheel gestures belong
 * to the document, even when an embedded native editor handles wheel input. */
export function useDocumentEmbedScroll(
  regionRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const region = regionRef.current;

    if (!region) return;

    return routeDocumentEmbedScroll(region);
  }, [regionRef]);
}

export function routeDocumentEmbedScroll(region: HTMLElement) {
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !(event.target instanceof Element)) return;

    const embed = event.target.closest(
      ".sequence-diagram, .flow-diagram, .database-lens, .code-peek",
    );

    if (!embed?.closest(".review-document") || !region.contains(embed)) return;

    // Capture before React Flow/Monaco or native overflow scrolling can consume
    // the gesture. Preserve trackpad deltas and normalize mouse line/page units.
    event.preventDefault();
    event.stopPropagation();
    const lineHeight = parseFloat(getComputedStyle(region).lineHeight) || 20;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight : 1;
    region.scrollBy({
      left:
        event.deltaX *
        (event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? region.clientWidth
          : unit),
      top:
        event.deltaY *
        (event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? region.clientHeight
          : unit),
      behavior: "instant",
    });
  };

  region.addEventListener("wheel", onWheel, { capture: true, passive: false });

  return () => region.removeEventListener("wheel", onWheel, { capture: true });
}
