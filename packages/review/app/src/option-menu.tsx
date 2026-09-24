import { type ReactNode, useRef, useState } from "react";

import { useDismissOnOutside } from "./use-dismiss-on-outside";

/** A single-choice menu; the caller renders the trigger's content. */
export function OptionMenu<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  className,
  triggerClassName,
  triggerProps,
  children,
}: {
  ariaLabel: string;
  value: T | undefined;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange(value: T): void;
  className: string;
  triggerClassName: string;
  triggerProps?: { "aria-pressed"?: boolean };
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissOnOutside(container, open, setOpen);

  return (
    <div
      className={`review-option-menu ${className}`}
      ref={container}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className={triggerClassName}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        {...triggerProps}
      >
        {children}
        <svg
          className="review-option-menu-chevron"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d={open ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="review-option-menu-options"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              {option.icon}
              <span>{option.label}</span>
              {option.value === value ? (
                <svg
                  className="review-option-menu-check"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path d="m5 10 3.5 3.5L15 6.5" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
