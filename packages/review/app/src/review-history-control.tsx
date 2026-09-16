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

type VersionList = ReviewDocumentVersionWire[] | null | "unavailable";

export const DisplayedReviewVersionContext = createContext<number | undefined>(
  undefined,
);

export function ReviewHistoryControl(): ReactElement | null {
  const { historicalRevision, listVersions } = useReview();
  const displayedVersion = useContext(DisplayedReviewVersionContext);
  const session = useReviewSession();
  const tutorial = useTutorial();
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
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
  const previous = versionItems[selectedIndex - 1];
  const next = selected ? versionItems[selectedIndex + 1] : undefined;

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
        className="review-history-button"
        aria-label="Previous version"
        title="Previous version"
        disabled={tutorial !== null || !previous}
        onClick={() => previous && selectVersion(previous)}
      >
        <VersionArrow direction="previous" />
      </button>
      <button
        type="button"
        className="review-history-button review-history-selected"
        aria-label="Version history"
        title="Version history"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={tutorial !== null}
        onClick={() => {
          if (tutorial) return;
          setOpen((current) => !current);

          if (!open) void loadVersions();
        }}
      >
        {selected ? (
          <>
            <span>{versionLabel(selected, selectedIndex)}</span>
            <time dateTime={new Date(selected.sealedAt).toISOString()}>
              {formatVersionTimestamp(selected.sealedAt)}
            </time>
          </>
        ) : (
          "Version history"
        )}
        <span aria-hidden="true">⌄</span>
      </button>
      <button
        type="button"
        className="review-history-button"
        aria-label="Next version"
        title="Next version"
        disabled={tutorial !== null || !next}
        onClick={() => next && selectVersion(next)}
      >
        <VersionArrow direction="next" />
      </button>
      {open ? (
        <ul className="review-history-list" role="menu">
          {versionItems.map((version, index) => (
            <li key={version.revision}>
              <button
                type="button"
                role="menuitem"
                disabled={version === selected}
                onClick={() => selectVersion(version)}
              >
                {versionLabel(version, index)} ·{" "}
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

function versionLabel(version: ReviewDocumentVersionWire, index: number) {
  return `Version ${/^[0-9]+$/.test(version.revision) ? version.revision : index + 1}`;
}

function VersionArrow({
  direction,
}: {
  direction: "previous" | "next";
}): ReactElement {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={direction === "previous" ? "M14 6l-6 6 6 6" : "M10 6l6 6-6 6"}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}
