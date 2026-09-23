import { type RefObject, useEffect } from "react";

export function useDismissOnOutside(
  container: RefObject<HTMLElement | null>,
  open: boolean,
  dismiss: (open: false) => void,
  pointerCapture = false,
  keyCapture = false,
) {
  useEffect(() => {
    if (!open) return;

    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        container.current?.contains(event.target)
      )
        return;
      dismiss(false);
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(false);
    };

    document.addEventListener("pointerdown", outside, pointerCapture);
    document.addEventListener("keydown", escape, keyCapture);

    return () => {
      document.removeEventListener("pointerdown", outside, pointerCapture);
      document.removeEventListener("keydown", escape, keyCapture);
    };
  }, [container, open, dismiss, pointerCapture, keyCapture]);
}
