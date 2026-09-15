import type { ReactElement } from "react";

export function CloseIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--close"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M7 7l10 10M17 7 7 17" />
    </svg>
  );
}

export function SlidersIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--sliders"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M4 8h4.5M13.5 8H20M4 16h6.5M15.5 16H20" />
      <circle cx="11" cy="8" r="2.5" />
      <circle cx="13" cy="16" r="2.5" />
    </svg>
  );
}

export function UnifiedLayoutIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--layout"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 10h8M8 14h8" />
    </svg>
  );
}

export function SplitLayoutIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--layout"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function BugIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--bug"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <rect x="8" y="7" width="8" height="12" rx="4" />
      <path d="M10 7V6a2 2 0 0 1 4 0v1M12 8v10" />
      <path d="M8 10H5M19 10h-3M8 14H5M19 14h-3M8.75 18 6 20M15.25 18 18 20" />
    </svg>
  );
}

export function ContentsIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--contents"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M8 7h10M8 12h10M8 17h10" />
      <path d="M5 7h.01M5 12h.01M5 17h.01" />
    </svg>
  );
}

export function TutorialIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--tutorial"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M4.5 5.5h4.75A2.75 2.75 0 0 1 12 8.25V19a2.75 2.75 0 0 0-2.75-2.75H4.5V5.5Z" />
      <path d="M19.5 5.5h-4.75A2.75 2.75 0 0 0 12 8.25V19a2.75 2.75 0 0 1 2.75-2.75h4.75V5.5Z" />
    </svg>
  );
}

export function PlusIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--plus"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MinusIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--minus"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

export function RefreshIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--refresh"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M19 7v5h-5" />
      <path d="M5 17v-5h5" />
      <path d="M18.25 12a6.25 6.25 0 0 0-10.6-4.5L5 10" />
      <path d="M5.75 12a6.25 6.25 0 0 0 10.6 4.5L19 14" />
    </svg>
  );
}

export function SettingsSlidersIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="review-debug-trigger-icon"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M4.5 8h15M4.5 16h15" />
      <circle cx="9" cy="8" r="2" />
      <circle cx="15" cy="16" r="2" />
    </svg>
  );
}

export function MapPinIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--map-pin"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M12 21s6-5.25 6-11a6 6 0 1 0-12 0c0 5.75 6 11 6 11Z" />
      <circle cx="12" cy="10" r="2.25" />
    </svg>
  );
}

export function DisclosureChevron({
  expanded,
}: {
  expanded: boolean;
}): ReactElement {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d={expanded ? "M3 4.5 6 7.5 9 4.5" : "M4.5 3 7.5 6 4.5 9"} />
    </svg>
  );
}
