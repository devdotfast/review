import type { WhiteboardDiffLayout } from "@dev.fast/whiteboard-protocol";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useWhiteboardSession } from "./host/whiteboard-session";
import { SlidersIcon, SplitLayoutIcon, UnifiedLayoutIcon } from "./icons";
import { captureClientError, captureUiEvent } from "./ui-telemetry";
import { useDismissOnOutside } from "./use-dismiss-on-outside";
import { useTooltip } from "./use-tooltip";
import { useTopbarPopover } from "./use-topbar-popover";

const LAYOUT_OPTIONS: ReadonlyArray<{
  layout: WhiteboardDiffLayout;
  label: string;
  Icon: () => ReactElement;
}> = [
  { layout: "unified", label: "Unified", Icon: UnifiedLayoutIcon },
  { layout: "split", label: "Split", Icon: SplitLayoutIcon },
];

/**
 * The toolbar's diff settings popover. Today it holds one control, the
 * unified/split layout; the popover shape leaves room for the diff options
 * that follow it without spending more toolbar width.
 */
export function DiffLayoutControl(): ReactElement {
  const tooltip = useTooltip("Diff settings");
  const session = useWhiteboardSession();
  const bridge = session.bridge;

  const layout = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const subscription = bridge.onDidChangeDiffLayout(onChange);

        return () => subscription.dispose();
      },
      [bridge],
    ),
    () => bridge.currentDiffLayout(),
  );

  const controlRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const popoverRef = useTopbarPopover(open, controlRef);
  // The desktop confirms a write by round-tripping the setting through its
  // change event. The choice shows at once and holds until that confirmation,
  // or drops back if the write fails.
  const [pending, setPending] = useState<WhiteboardDiffLayout | null>(null);
  const shownLayout = pending ?? layout;
  const layoutLabelId = useId();

  useEffect(() => {
    if (pending !== null && layout === pending) setPending(null);
  }, [layout, pending]);

  useDismissOnOutside(controlRef, open, setOpen, true, true);

  const chooseLayout = (next: WhiteboardDiffLayout) => {
    if (next === shownLayout) return;
    captureUiEvent(session, "diff_layout_changed", { layout: next });
    setPending(next);
    bridge.setDiffLayout(next).catch((error: Error) => {
      setPending(null);
      captureClientError(session, "settings", error, {
        component: "diff_layout",
      });
    });
  };

  return (
    <div ref={controlRef} className="whiteboard-diff-settings">
      <button
        type="button"
        className="whiteboard-diff-settings-button"
        aria-label="Diff settings"
        ref={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersIcon />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          popover="manual"
          className="whiteboard-diff-settings-popover"
          role="dialog"
          aria-label="Diff settings"
        >
          <div className="whiteboard-diff-settings-title">Diff settings</div>
          <div className="whiteboard-diff-settings-field">
            <span id={layoutLabelId} className="whiteboard-diff-settings-label">
              Layout
            </span>
            <div
              className="whiteboard-segmented whiteboard-diff-settings-segmented"
              role="radiogroup"
              aria-labelledby={layoutLabelId}
            >
              {LAYOUT_OPTIONS.map(({ layout: option, label, Icon }) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={option === shownLayout}
                  className={
                    option === shownLayout
                      ? "whiteboard-segment whiteboard-segment--active"
                      : "whiteboard-segment"
                  }
                  onClick={() => chooseLayout(option)}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
