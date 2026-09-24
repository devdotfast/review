/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * RFC 9562 UUIDv7: a 48-bit big-endian millisecond timestamp, version 7,
 * variant 10xx, and 74 random bits. PostHog keys sessions on `$session_id`
 * and accepts only this version.
 */
export function uuidV7(now: number = Date.now(), random: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(16))): string {
	const bytes = Uint8Array.from(random.subarray(0, 16));
	let timestamp = Math.floor(now);
	for (let index = 5; index >= 0; index--) {
		bytes[index] = timestamp % 256;
		timestamp = Math.floor(timestamp / 256);
	}
	bytes[6] = 0x70 | (bytes[6] & 0x0f);
	bytes[8] = 0x80 | (bytes[8] & 0x3f);
	const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
