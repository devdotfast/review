import { useCallback } from "react";

import { useOptionalWhiteboardSession } from "./host/whiteboard-session";

export function useTooltip<T extends HTMLElement = HTMLButtonElement>(
  text: string,
) {
  const setupTooltip = useOptionalWhiteboardSession()?.bridge.setupTooltip;

  return useCallback(
    (target: T | null) => {
      if (!target) return;

      if (setupTooltip) {
        const tooltip = setupTooltip(target, text);

        return () => tooltip.dispose();
      }

      target.title = text;

      return () => target.removeAttribute("title");
    },
    [setupTooltip, text],
  );
}
