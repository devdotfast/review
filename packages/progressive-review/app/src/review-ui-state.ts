import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewClientConfig } from "./host/review-client";
import { reviewPreferenceKey, reviewStorageKey } from "./host/review-client";
import { useReviewSession } from "./host/review-session";

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
 * `readReviewUiState`/`writeReviewUiState` take a key so callers that already
 * own a key shape keep it; `useReviewUiState` builds one for the common case of
 * remembering a single value.
 */
export type ReviewUiScope = "reader" | "session" | "window";

type ReviewUiStateOptions = {
  scope?: ReviewUiScope;
  /** Key namespace; defaults to `ui`. */
  namespace?: string;
};

export function useReviewUiState<T>(
  name: string,
  fallback: T,
  { scope = "reader", namespace = "ui" }: ReviewUiStateOptions = {},
): [T, Dispatch<SetStateAction<T>>] {
  const session = useReviewSession();
  const key = reviewUiStateKey(session.config, scope, namespace, name);
  const [value, setValue] = useState<T>(
    () => readReviewUiState<T>(scope, key) ?? fallback,
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
    if (changed.current) writeReviewUiState(scope, key, value);
  }, [key, scope, value]);
  return [value, setStoredValue];
}

export function reviewUiStateKey(
  config: ReviewClientConfig | null,
  scope: ReviewUiScope,
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return scope === "reader"
    ? reviewPreferenceKey(namespace, ...parts)
    : reviewStorageKey(config, namespace, ...parts);
}

export function readReviewUiState<T>(
  scope: ReviewUiScope,
  key: string,
): T | null {
  try {
    const raw = reviewUiStorage(scope)?.getItem(key);
    // SAFETY: the caller owns `key` and wrote it through writeReviewUiState
    // with this same T; readers of foreign or versioned formats ask for
    // JsonValue and parse further.
    return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
  } catch {
    // Private mode, a quota error, or a value written by an older format.
    return null;
  }
}

export function writeReviewUiState<T>(
  scope: ReviewUiScope,
  key: string,
  value: T,
): void {
  try {
    reviewUiStorage(scope)?.setItem(key, JSON.stringify(value));
  } catch {
    // Persisting review UI state is always best-effort.
  }
}

export function removeReviewUiState(scope: ReviewUiScope, key: string): void {
  try {
    reviewUiStorage(scope)?.removeItem(key);
  } catch {
    // Nothing to do if the entry cannot be removed.
  }
}

/** Drops every entry in `scope` whose key matches, newest first. */
export function forgetReviewUiState(
  scope: ReviewUiScope,
  matches: (key: string) => boolean,
): void {
  try {
    const storage = reviewUiStorage(scope);
    if (!storage) return;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key && matches(key)) storage.removeItem(key);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function reviewUiStorage(scope: ReviewUiScope): Storage | null {
  if (typeof window === "undefined") return null;
  return scope === "window" ? window.sessionStorage : window.localStorage;
}
