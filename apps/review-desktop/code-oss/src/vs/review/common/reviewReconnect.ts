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
