import type { ReviewDocumentVersionWire } from "@dev.fast/review-protocol";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session";
import { useReview } from "./review-context";
import { useTutorial } from "./tutorial-context";

type VersionList = ReviewDocumentVersionWire[] | null | "unavailable";

export function ReviewHistoryControl(): ReactElement | null {
  const { historicalRevision, listVersions } = useReview();
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
    if (historicalRevision || tutorial) return;
    void loadVersions();
  }, [historicalRevision, loadVersions, tutorial]);

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

  if (
    historicalRevision ||
    (!tutorial && (!Array.isArray(versions) || versions.length === 0))
  ) {
    return null;
  }
  const versionItems = Array.isArray(versions) ? versions : [];

  return (
    <div ref={controlRef} className="review-history">
      <button
        type="button"
        className="review-history-button"
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
        <HistoryIcon />
      </button>
      {open ? (
        <ul className="review-history-list" role="menu">
          {versionItems.map((version) => (
            <li key={version.revision}>
              <button
                type="button"
                role="menuitem"
                disabled={version.isCurrent}
                onClick={() => {
                  setOpen(false);
                  void session.surface.post({
                    name: "openReviewRevision",
                    args: {
                      revision: version.revision,
                      sealedAt: version.sealedAt,
                    },
                  });
                }}
              >
                {formatVersionTimestamp(version.sealedAt)}
                {version.isCurrent ? " — Current" : ""}
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

function HistoryIcon(): ReactElement {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.7 8.1A8 8 0 1 1 4 12M4.7 8.1H1.5m3.2 0V4.9M12 7.5V12l3 1.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}
