import type { ReviewDiffLayout } from "@dev.fast/review-protocol";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useReviewSession } from "./host/review-session";
import { SlidersIcon, SplitLayoutIcon, UnifiedLayoutIcon } from "./icons";
import { captureClientError, captureUiEvent } from "./ui-telemetry";

const LAYOUT_OPTIONS: ReadonlyArray<{
  layout: ReviewDiffLayout;
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
  const session = useReviewSession();
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
  // The desktop confirms a write by round-tripping the setting through its
  // change event. The choice shows at once and holds until that confirmation,
  // or drops back if the write fails.
  const [pending, setPending] = useState<ReviewDiffLayout | null>(null);
  const shownLayout = pending ?? layout;
  const layoutLabelId = useId();

  useEffect(() => {
    if (pending !== null && layout === pending) setPending(null);
  }, [layout, pending]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && controlRef.current?.contains(target))
        return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  const chooseLayout = (next: ReviewDiffLayout) => {
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
    <div ref={controlRef} className="review-diff-settings">
      <button
        type="button"
        className="review-diff-settings-button"
        aria-label="Diff settings"
        title="Diff settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersIcon />
      </button>
      {open ? (
        <div
          className="review-diff-settings-popover"
          role="dialog"
          aria-label="Diff settings"
        >
          <div className="review-diff-settings-title">Diff settings</div>
          <div className="review-diff-settings-field">
            <span id={layoutLabelId} className="review-diff-settings-label">
              Layout
            </span>
            <div
              className="review-segmented review-diff-settings-segmented"
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
                      ? "review-segment review-segment--active"
                      : "review-segment"
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
