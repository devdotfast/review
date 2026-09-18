import type { ReviewDocumentVersionWire } from "@dev.fast/review-protocol";
import {
  type ReactElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session";
import { useReview } from "./review-context";
import { useTutorial } from "./tutorial-context";
import { useDismissOnOutside } from "./use-dismiss-on-outside";
import { useTooltip } from "./use-tooltip";
import { useTopbarPopover } from "./use-topbar-popover";

type VersionList = ReviewDocumentVersionWire[] | null | "unavailable";

export const DisplayedReviewVersionContext = createContext<number | undefined>(
  undefined,
);

export function ReviewHistoryControl(): ReactElement | null {
  const { historicalRevision, listVersions } = useReview();
  const displayedVersion = useContext(DisplayedReviewVersionContext);
  const session = useReviewSession();
  const tutorial = useTutorial();
  const historyTooltip = useTooltip("Version history");
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const popoverRef = useTopbarPopover<HTMLUListElement>(open, controlRef);
  const [versions, setVersions] = useState<VersionList>(null);

  const loadVersions = useCallback(async () => {
    try {
      const result = await listVersions();
      setVersions(result ?? "unavailable");
    } catch {
      setVersions("unavailable");
    }
  }, [listVersions]);

  useEffect(() => {
    if (tutorial) return;
    void loadVersions();
  }, [displayedVersion, historicalRevision, loadVersions, tutorial]);

  useDismissOnOutside(controlRef, open, setOpen, true, true);

  if (!tutorial && !Array.isArray(versions)) {
    return null;
  }

  const versionItems = Array.isArray(versions)
    ? [...versions].sort((a, b) =>
        /^[0-9]+$/.test(a.revision) && /^[0-9]+$/.test(b.revision)
          ? Number(a.revision) - Number(b.revision)
          : a.sealedAt - b.sealedAt,
      )
    : [];

  const selectedRevision =
    displayedVersion !== undefined
      ? String(displayedVersion)
      : historicalRevision;

  const selectedIndex = versionItems.findIndex((item) =>
    selectedRevision ? item.revision === selectedRevision : item.isCurrent,
  );

  const selected = versionItems[selectedIndex];

  function selectVersion(version: ReviewDocumentVersionWire) {
    setOpen(false);
    void session.surface.post({
      name: "openReviewRevision",
      args:
        version === versionItems.at(-1)
          ? {}
          : { revision: version.revision, sealedAt: version.sealedAt },
    });
  }

  return (
    <div ref={controlRef} className="review-history">
      <button
        type="button"
        className="review-history-button review-history-selected"
        aria-label="Version history"
        ref={historyTooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={tutorial !== null}
        onClick={() => {
          if (tutorial) return;
          setOpen((current) => !current);

          if (!open) void loadVersions();
        }}
      >
        <span>
          {selected
            ? `v${versionNumber(selected, selectedIndex)}`
            : displayedVersion !== undefined
              ? `v${displayedVersion}`
              : "Versions"}
        </span>
        <svg
          className="ui-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      </button>
      {open ? (
        <ul
          ref={popoverRef}
          popover="manual"
          className="review-history-list"
          role="menu"
        >
          {versionItems.map((version, index) => (
            <li key={version.revision}>
              <button
                type="button"
                role="menuitem"
                disabled={version === selected}
                onClick={() => selectVersion(version)}
              >
                Version {versionNumber(version, index)} ·{" "}
                {formatVersionTimestamp(version.sealedAt)}
                {version === selected ? " — Current" : ""}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatVersionTimestamp(sealedAt: number): string {
  return new Date(sealedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function versionNumber(version: ReviewDocumentVersionWire, index: number) {
  return /^[0-9]+$/.test(version.revision) ? version.revision : index + 1;
}
