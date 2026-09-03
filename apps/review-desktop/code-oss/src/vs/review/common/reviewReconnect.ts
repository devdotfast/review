/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export const REVIEW_SERVER_RESTART_DELAYS = [250, 1_000, 2_000] as const;

// Keep the renderer retrying after the utility host has scheduled its final
// restart. The replacement process still needs time to boot and attach its
// authenticated event streams after the host's delay has elapsed.
export const REVIEW_CLIENT_RECONNECT_DELAYS = [
  ...REVIEW_SERVER_RESTART_DELAYS,
  4_000,
] as const;

export interface ReviewReconnectOptions {
  /** Observes each failure before the next delay. */
  readonly onRetry?: (error: unknown) => void;
  /**
   * Called once every delay in the table has been used since the last
   * successful connection. Omit it to keep retrying at the last delay.
   */
  readonly onExhausted?: (error: unknown) => never;
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Runs `connect` until it resolves or `signal` aborts, backing off through
 * `REVIEW_CLIENT_RECONNECT_DELAYS` between failures. `connect` receives an
 * `onConnected` callback that restarts the delay table.
 */
export async function reconnectUntilAborted(
  signal: AbortSignal,
  connect: (onConnected: () => void) => Promise<void>,
  options: ReviewReconnectOptions = {},
): Promise<void> {
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await connect(() => {
        attempt = 0;
      });
      return;
    } catch (error) {
      if (signal.aborted) return;
      options.onRetry?.(error);
      let delay = REVIEW_CLIENT_RECONNECT_DELAYS[attempt++];
      if (delay === undefined) {
        options.onExhausted?.(error);
        delay =
          REVIEW_CLIENT_RECONNECT_DELAYS[
            REVIEW_CLIENT_RECONNECT_DELAYS.length - 1
          ];
      }
      await wait(delay);
    }
  }
}
