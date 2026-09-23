import type { JsonValue } from "@dev.fast/whiteboard-protocol";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { WhiteboardSession } from "./host/whiteboard-session";
import { useWhiteboardSession } from "./host/whiteboard-session";
import {
  readWhiteboardUiState,
  writeWhiteboardUiState,
} from "./whiteboard-ui-state";

export type WhiteboardTheme = "dark" | "light";

export type WhiteboardNodeTint = "none" | "slate" | "mineral";

export interface WhiteboardDebugSettings {
  showModifiedOnly: boolean;
  setShowModifiedOnly: (showModifiedOnly: boolean) => void;
  showRemovedNodes: boolean;
  setShowRemovedNodes: (showRemovedNodes: boolean) => void;
  theme: WhiteboardTheme;
  nodeTint: WhiteboardNodeTint;
  setNodeTint: (nodeTint: WhiteboardNodeTint) => void;
}

const debugSettingsStorageKey = (session: WhiteboardSession) =>
  session.storageKey("debug-settings");

const WhiteboardDebugSettingsContext =
  createContext<WhiteboardDebugSettings | null>(null);

export function WhiteboardDebugSettingsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const session = useWhiteboardSession();
  const [settings, setSettings] = useState(() => readStoredSettings(session));
  const [theme, setTheme] = useState<WhiteboardTheme>(() => session.theme());

  useEffect(() => {
    writeWhiteboardUiState(
      "session",
      debugSettingsStorageKey(session),
      settings,
    );
  }, [session, settings]);

  useEffect(() => {
    return session.surface.subscribe((event) => {
      if (event.event === "themeChanged") setTheme(event.theme);
    });
  }, [session]);

  const value = useMemo<WhiteboardDebugSettings>(
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
    <WhiteboardDebugSettingsContext.Provider value={value}>
      {children}
    </WhiteboardDebugSettingsContext.Provider>
  );
}

export function useWhiteboardDebugSettings() {
  const settings = useContext(WhiteboardDebugSettingsContext);

  if (!settings) {
    throw new Error(
      "useWhiteboardDebugSettings must be used within WhiteboardDebugSettingsProvider",
    );
  }

  return settings;
}

interface StoredWhiteboardDebugSettings {
  showModifiedOnly: boolean;
  showRemovedNodes: boolean;
  nodeTint: WhiteboardNodeTint;
  settingsVersion: number;
}

// Version 3 removes the Review-owned theme preference. Theme always follows
// the Code OSS host, while the remaining debug settings continue to migrate.
const SETTINGS_VERSION = 3;

// Storage returns null during SSR and for anything unreadable, so the field
// normalizers below produce the defaults from an empty record.
function readStoredSettings(
  session: WhiteboardSession,
): StoredWhiteboardDebugSettings {
  const parsed =
    readWhiteboardUiState<Partial<StoredWhiteboardDebugSettings>>(
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

function normalizeNodeTint(value: JsonValue | undefined): WhiteboardNodeTint {
  return value === "none" || value === "mineral" || value === "slate"
    ? value
    : "slate";
}
