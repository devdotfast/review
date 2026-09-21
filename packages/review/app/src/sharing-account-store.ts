import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { ReviewApiClient } from "../../src/review-api/client";

export interface SharingAccount {
  account: { login: string; origin: string } | null;
  pending: boolean;
  url?: string;
  error?: string;
}

interface SharingAccountState {
  client?: ReviewApiClient;
  /** Undefined until the first read completes. */
  account?: SharingAccount;
  error?: string;
  load: () => Promise<void>;
  login: () => Promise<void>;
}

const POLL_WHILE_PENDING_MS = 2000;

/** App-wide sign-in state for sharing; the popover reads it without a round trip. */
export const sharingAccountStore = createStore<SharingAccountState>()(
  (set, get) => ({
    load: async () => {
      const { client } = get();

      if (!client) return;

      try {
        const account = await client.read<SharingAccount>("/sharing/account");

        if (get().client === client) set({ account, error: undefined });
      } catch {
        if (get().client === client)
          set({ error: "Could not read sign-in status." });
      }
    },
    login: async () => {
      const { client } = get();

      if (!client) return;
      await client.post("/sharing/login", {});
      set({ account: { account: null, pending: true } });
    },
  }),
);

/**
 * Binds the store to a client, loads once, refreshes when the window regains
 * focus, and polls only while a GitHub sign-in is pending.
 */
export function watchSharingAccount(client: ReviewApiClient) {
  const store = sharingAccountStore;

  if (store.getState().client !== client)
    store.setState({ client, account: undefined, error: undefined });

  const load = () => void store.getState().load();

  load();
  window.addEventListener("focus", load);
  let interval: ReturnType<typeof setInterval> | undefined;

  const syncPolling = () => {
    const pending = Boolean(store.getState().account?.pending);

    if (pending && interval === undefined)
      interval = setInterval(load, POLL_WHILE_PENDING_MS);
    else if (!pending && interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  syncPolling();
  const unsubscribe = store.subscribe(syncPolling);

  return () => {
    unsubscribe();
    window.removeEventListener("focus", load);

    if (interval !== undefined) clearInterval(interval);
  };
}

export function useSharingAccount<T>(
  selector: (state: SharingAccountState) => T,
): T {
  return useStore(sharingAccountStore, selector);
}
