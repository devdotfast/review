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

export function CommentIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--comment"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M6.25 5.75h11.5a2.5 2.5 0 0 1 2.5 2.5v5.25a2.5 2.5 0 0 1-2.5 2.5h-6.5L7 19.25V16H6.25a2.5 2.5 0 0 1-2.5-2.5V8.25a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M8 10h8M8 12.75h5.25" />
    </svg>
  );
}

/** The comment bubble with its text lines replaced by a check: a resolved thread. */
export function ResolvedCommentIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--comment-resolved"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M6.25 5.75h11.5a2.5 2.5 0 0 1 2.5 2.5v5.25a2.5 2.5 0 0 1-2.5 2.5h-6.5L7 19.25V16H6.25a2.5 2.5 0 0 1-2.5-2.5V8.25a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M8.75 11.25l2.25 2.25 4.25-4.5" />
    </svg>
  );
}

export function ThreadsIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--threads"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M5.25 4.75h10.5a2.5 2.5 0 0 1 2.5 2.5v3.5a2.5 2.5 0 0 1-2.5 2.5h-5.5L6.5 16v-2.75H5.25a2.5 2.5 0 0 1-2.5-2.5v-3.5a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M10 16.25h4.5l3 2.25v-2.25h1.25a2.5 2.5 0 0 0 2.5-2.5v-2" />
    </svg>
  );
}

export function TerminalIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--terminal"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="m5 7 5 5-5 5M12.5 17H19" />
    </svg>
  );
}

export function SparkIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--spark"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="m13.5 3-7 10h5l-1 8 7-11h-5l1-7Z" />
    </svg>
  );
}

export function AddToReviewIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--add-to-review"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <rect x="3.75" y="5.75" width="16.5" height="12.5" rx="3" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  );
}

export function SubmitIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--submit"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M5 12h13" />
      <path d="M13 7l5 5-5 5" />
    </svg>
  );
}

export function TrashIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--trash"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M5 7h14" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.8 11a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11" />
      <path d="M10 10.5v6M14 10.5v6" />
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

export function MoreIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--more"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <circle cx="6.5" cy="12" r="1.25" />
      <circle cx="12" cy="12" r="1.25" />
      <circle cx="17.5" cy="12" r="1.25" />
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

export function ResolveIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--resolve"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}

export function ExpandIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ui-icon ui-icon--expand"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path d="M14 5h5v5M19 5l-7.5 7.5M10 19H5v-5" />
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
