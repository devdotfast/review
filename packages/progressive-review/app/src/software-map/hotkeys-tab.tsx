import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { MinusIcon, PlusIcon } from "../icons";

export interface SoftwareMapHotkeyItem {
  keys: readonly string[];
  label: string;
}

export interface SoftwareMapHotkeyGroup {
  id: string;
  label: string;
  items: readonly SoftwareMapHotkeyItem[];
}

interface SoftwareMapHotkeysTabProps {
  groups: readonly SoftwareMapHotkeyGroup[];
  activeGroupId: string;
  open: boolean;
  ariaLabel: string;
  onOpenChange: (open: boolean) => void;
}

export function SoftwareMapHotkeysTab({
  groups,
  activeGroupId,
  open,
  ariaLabel,
  onOpenChange,
}: SoftwareMapHotkeysTabProps): ReactElement {
  const rootRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const collapsedButtonRef = useRef<HTMLButtonElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  const measureWidth = useCallback(() => {
    const root = rootRef.current;
    const strip = stripRef.current;
    const toggle = toggleRef.current;
    const collapsedButton = collapsedButtonRef.current;

    if (!root || !strip || !toggle || !collapsedButton) {
      return;
    }

    const styles = getComputedStyle(root);
    const borderWidth =
      Number.parseFloat(styles.borderLeftWidth) +
      Number.parseFloat(styles.borderRightWidth);
    const openWidth = strip.scrollWidth + toggle.offsetWidth + borderWidth;
    const collapsedWidth = collapsedButton.scrollWidth + borderWidth;
    const nextWidth = Math.ceil(open ? openWidth : collapsedWidth);

    setMeasuredWidth((currentWidth) =>
      currentWidth === nextWidth ? currentWidth : nextWidth,
    );
  }, [open]);

  useLayoutEffect(() => {
    measureWidth();
  }, [measureWidth, groups, activeGroupId]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => measureWidth());
    const observedElements = [
      stripRef.current,
      toggleRef.current,
      collapsedButtonRef.current,
    ];

    for (const element of observedElements) {
      if (element) {
        observer.observe(element);
      }
    }

    return () => observer.disconnect();
  }, [measureWidth]);

  const style =
    measuredWidth === null
      ? undefined
      : ({
          "--software-map-hotkeys-width": `${measuredWidth}px`,
        } as CSSProperties);

  return (
    <aside
      ref={rootRef}
      className={[
        "software-map-code-hotkeys",
        open
          ? "software-map-code-hotkeys--open"
          : "software-map-code-hotkeys--collapsed",
      ].join(" ")}
      aria-label={open ? ariaLabel : undefined}
      style={style}
      onKeyDown={stopSoftwareMapHotkeysKeyDown}
    >
      <div className="software-map-code-hotkeys-panel" aria-hidden={!open}>
        <div ref={stripRef} className="software-map-code-hotkeys-strip">
          {groups.map((group) => (
            <div
              key={group.id}
              className={[
                "software-map-code-hotkeys-group",
                group.id === activeGroupId
                  ? "software-map-code-hotkeys-group--active"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="software-map-code-hotkeys-group-label">
                {group.label}
              </span>
              {group.items.map((item) => (
                <span
                  key={`${group.id}:${item.label}`}
                  className="software-map-code-hotkeys-item"
                  title={item.label}
                >
                  <span className="software-map-code-hotkeys-keys">
                    {item.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                  <span className="software-map-code-hotkeys-item-label">
                    {item.label}
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
        <button
          ref={toggleRef}
          type="button"
          className="software-map-code-hotkeys-toggle"
          aria-label="Minimize software map hotkeys"
          aria-expanded="true"
          tabIndex={open ? 0 : -1}
          onClick={() => onOpenChange(false)}
        >
          <MinusIcon />
        </button>
      </div>
      <button
        ref={collapsedButtonRef}
        type="button"
        className="software-map-code-hotkeys-collapsed-button"
        aria-label="Show software map hotkeys"
        aria-expanded="false"
        tabIndex={open ? -1 : 0}
        onClick={() => onOpenChange(true)}
      >
        <span>Hotkeys</span>
        <PlusIcon />
      </button>
    </aside>
  );
}

function stopSoftwareMapHotkeysKeyDown(event: KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}
