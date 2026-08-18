import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { ReviewSession } from "./host/review-session";
import { useReviewSession } from "./host/review-session";
import { readReviewUiState, writeReviewUiState } from "./review-ui-state";

export type ReviewTheme = "dark" | "light";

export type ReviewNodeTint = "none" | "slate" | "mineral";

export interface ReviewDebugSettings {
  showModifiedOnly: boolean;
  setShowModifiedOnly: (showModifiedOnly: boolean) => void;
  showRemovedNodes: boolean;
  setShowRemovedNodes: (showRemovedNodes: boolean) => void;
  theme: ReviewTheme;
  nodeTint: ReviewNodeTint;
  setNodeTint: (nodeTint: ReviewNodeTint) => void;
}

const debugSettingsStorageKey = (session: ReviewSession) =>
  session.storageKey("debug-settings");

const ReviewDebugSettingsContext = createContext<ReviewDebugSettings | null>(
  null,
);

export function ReviewDebugSettingsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const session = useReviewSession();
  const [settings, setSettings] = useState(() => readStoredSettings(session));
  const [theme, setTheme] = useState<ReviewTheme>(() => session.theme());

  useEffect(() => {
    writeReviewUiState("session", debugSettingsStorageKey(session), settings);
  }, [session, settings]);

  useEffect(() => {
    return session.surface.subscribe((event) => {
      if (event.event === "themeChanged") setTheme(event.theme);
    });
  }, [session]);

  const value = useMemo<ReviewDebugSettings>(
    () => ({
      showModifiedOnly: settings.showModifiedOnly,
      setShowModifiedOnly: (showModifiedOnly) =>
        setSettings((current) => ({ ...current, showModifiedOnly })),
      showRemovedNodes: settings.showRemovedNodes,
      setShowRemovedNodes: (showRemovedNodes) =>
        setSettings((current) => ({ ...current, showRemovedNodes })),
      theme,
      nodeTint: settings.nodeTint,
      setNodeTint: (nodeTint) =>
        setSettings((current) => ({ ...current, nodeTint })),
    }),
    [
      settings.showModifiedOnly,
      settings.showRemovedNodes,
      settings.nodeTint,
      theme,
    ],
  );

  return (
    <ReviewDebugSettingsContext.Provider value={value}>
      {children}
    </ReviewDebugSettingsContext.Provider>
  );
}

export function useReviewDebugSettings() {
  const settings = useContext(ReviewDebugSettingsContext);
  if (!settings) {
    throw new Error(
      "useReviewDebugSettings must be used within ReviewDebugSettingsProvider",
    );
  }
  return settings;
}

interface StoredReviewDebugSettings {
  showModifiedOnly: boolean;
  showRemovedNodes: boolean;
  nodeTint: ReviewNodeTint;
  settingsVersion: number;
}

// Version 3 removes the Review-owned theme preference. Theme always follows
// the Code OSS host, while the remaining debug settings continue to migrate.
const SETTINGS_VERSION = 3;

// Storage returns null during SSR and for anything unreadable, so the field
// normalizers below produce the defaults from an empty record.
function readStoredSettings(session: ReviewSession): StoredReviewDebugSettings {
  const parsed =
    readReviewUiState<Partial<StoredReviewDebugSettings>>(
      "session",
      debugSettingsStorageKey(session),
    ) ?? {};
  return {
    showModifiedOnly: parsed.showModifiedOnly !== false,
    showRemovedNodes: parsed.showRemovedNodes !== false,
    nodeTint: normalizeNodeTint(parsed.nodeTint),
    settingsVersion: SETTINGS_VERSION,
  };
}

function normalizeNodeTint(value: unknown): ReviewNodeTint {
  return value === "none" || value === "mineral" || value === "slate"
    ? value
    : "slate";
}
