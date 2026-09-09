import type { ReviewListError } from "@dev.fast/review-protocol";
import { useSyncExternalStore } from "react";

import { CopyPromptButton } from "./copy-prompt-button";

export const REVIEW_MIGRATION_PROMPT =
  "Use the local `review` CLI to migrate my Review data. Run `review migrate apply`. If a code comment position cannot be recovered, rerun `review migrate apply --force` to drop only the unrecoverable threads. Then restart Review and confirm that the Reviews and comments load.";

export const REVIEW_MIGRATION_DISMISSED_VERSION_KEY =
  "dev.fast.review.migrationDismissedVersion.v1";
const dismissalChanged = "review-migration-dismissal-changed";
let fallbackDismissedVersion: string | null = null;

function readDismissedVersion(): string | null {
  if (fallbackDismissedVersion !== null) return fallbackDismissedVersion;
  try {
    return (
      globalThis.localStorage?.getItem(
        REVIEW_MIGRATION_DISMISSED_VERSION_KEY,
      ) ?? null
    );
  } catch {
    return null;
  }
}

function subscribeToDismissal(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === REVIEW_MIGRATION_DISMISSED_VERSION_KEY
    ) {
      fallbackDismissedVersion = null;
      onChange();
    }
  };
  // Canvases share a window; storage events only notify other windows.
  window.addEventListener(dismissalChanged, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(dismissalChanged, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function dismissForVersion(appVersion: string): void {
  fallbackDismissedVersion = appVersion;
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(
        REVIEW_MIGRATION_DISMISSED_VERSION_KEY,
        appVersion,
      );
      fallbackDismissedVersion = null;
    }
  } catch {
    // Keep dismissal working across canvases when DOM storage is disabled.
  }
  window.dispatchEvent(new Event(dismissalChanged));
}

export function ReviewMigrationToast({
  errors,
  appVersion,
}: {
  errors: readonly ReviewListError[];
  appVersion: string;
}) {
  const dismissedVersion = useSyncExternalStore(
    subscribeToDismissal,
    readDismissedVersion,
  );
  const migrationCount = errors.filter(
    (error) => error.code === "MIGRATION_REQUIRED",
  ).length;
  if (migrationCount === 0 || dismissedVersion === appVersion) return null;
  return (
    <section
      className="review-migration-toast"
      aria-label="Review migration required"
    >
      <span role="status">
        {`${migrationCount} ${migrationCount === 1 ? "Review needs" : "Reviews need"} migration.`}
      </span>
      <div className="review-migration-toast-actions">
        <CopyPromptButton prompt={REVIEW_MIGRATION_PROMPT} />
        <button
          type="button"
          className="review-migration-toast-dismiss"
          aria-label="Dismiss migration reminder"
          title="Hide until the next app update"
          onClick={() => dismissForVersion(appVersion)}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
