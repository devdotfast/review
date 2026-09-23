import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WhiteboardClientConfig } from "./host/whiteboard-client";
import {
  whiteboardPreferenceKey,
  whiteboardStorageKey,
} from "./host/whiteboard-client";
import { useWhiteboardSession } from "./host/whiteboard-session";

/**
 * The one place the Review app reaches for browser storage.
 *
 * Review surfaces remount more often than they look like they do: the map view
 * is only rendered while its tab is active, the expanded map is a second frame
 * instance, and the desktop canvas rebuilds its React tree whenever the editor
 * tab switches to another review session. State that a reader set deliberately,
 * and caches worth surviving a reload, therefore live in storage rather than in
 * component state.
 *
 * Three scopes, each named for how long its state should outlive the thing that
 * created it:
 *
 * - `reader` — a preference the reader set by hand. Keyed without the session or
 *   route, so it follows them into every review and survives a relaunch.
 * - `session` — belongs to one review session, but should survive a reload.
 * - `window` — dies with the window: caches and transient UI state.
 *
 * `readWhiteboardUiState`/`writeWhiteboardUiState` take a key so callers that already
 * own a key shape keep it; `useWhiteboardUiState` builds one for the common case of
 * remembering a single value.
 */
export type WhiteboardUiScope = "reader" | "session" | "window";

type WhiteboardUiStateOptions = {
  scope?: WhiteboardUiScope;
  /** Key namespace; defaults to `ui`. */
  namespace?: string;
};

export function useWhiteboardUiState<T>(
  name: string,
  fallback: T,
  { scope = "reader", namespace = "ui" }: WhiteboardUiStateOptions = {},
): [T, Dispatch<SetStateAction<T>>] {
  const session = useWhiteboardSession();
  const key = whiteboardUiStateKey(session.config, scope, namespace, name);

  const [value, setValue] = useState<T>(
    () => readWhiteboardUiState<T>(scope, key) ?? fallback,
  );

  // Only state somebody actually changed is written back. Persisting on mount
  // instead would store the caller's fallback for every panel and section a
  // reader merely looked at, which then shadows a later change to that
  // fallback — an authored `[collapsed]` section could never take effect again.
  const changed = useRef(false);

  const setStoredValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    changed.current = true;
    setValue(next);
  }, []);

  useEffect(() => {
    if (changed.current) writeWhiteboardUiState(scope, key, value);
  }, [key, scope, value]);

  return [value, setStoredValue];
}

export function whiteboardUiStateKey(
  config: WhiteboardClientConfig | null,
  scope: WhiteboardUiScope,
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return scope === "reader"
    ? whiteboardPreferenceKey(namespace, ...parts)
    : whiteboardStorageKey(config, namespace, ...parts);
}

export function readWhiteboardUiState<T>(
  scope: WhiteboardUiScope,
  key: string,
): T | null {
  try {
    const raw = whiteboardUiStorage(scope)?.getItem(key);

    // SAFETY: the caller owns `key` and wrote it through writeWhiteboardUiState
    // with this same T; readers of foreign or versioned formats ask for
    // JsonValue and parse further.
    return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
  } catch {
    // Private mode, a quota error, or a value written by an older format.
    return null;
  }
}

export function writeWhiteboardUiState<T>(
  scope: WhiteboardUiScope,
  key: string,
  value: T,
): void {
  try {
    whiteboardUiStorage(scope)?.setItem(key, JSON.stringify(value));
  } catch {
    // Persisting review UI state is always best-effort.
  }
}

export function removeWhiteboardUiState(
  scope: WhiteboardUiScope,
  key: string,
): void {
  try {
    whiteboardUiStorage(scope)?.removeItem(key);
  } catch {
    // Nothing to do if the entry cannot be removed.
  }
}

/** Drops every entry in `scope` whose key matches, newest first. */
export function forgetWhiteboardUiState(
  scope: WhiteboardUiScope,
  matches: (key: string) => boolean,
): void {
  try {
    const storage = whiteboardUiStorage(scope);

    if (!storage) return;

    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);

      if (key && matches(key)) storage.removeItem(key);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function whiteboardUiStorage(scope: WhiteboardUiScope): Storage | null {
  if (typeof window === "undefined") return null;

  return scope === "window" ? window.sessionStorage : window.localStorage;
}
