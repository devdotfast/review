import { type RefObject, useId, useLayoutEffect, useRef } from "react";

export function useTopbarPopover<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  control: RefObject<HTMLElement | null>,
) {
  const popover = useRef<T>(null);
  const anchor = `--topbar-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  useLayoutEffect(() => {
    const element = popover.current;
    const target = control.current;

    if (!open || !element || !target) return;
    target.style.setProperty("anchor-name", anchor);
    element.style.setProperty("position-anchor", anchor);
    element.showPopover?.();

    return () => {
      element.hidePopover?.();
      target.style.removeProperty("anchor-name");
    };
  }, [open, control, anchor]);

  return popover;
}
