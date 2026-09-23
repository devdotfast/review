/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Caches in-flight and settled module loads by key. Concurrent callers share
 * one promise, a fulfilled load stays cached until `clear()`, and a rejected
 * load is evicted so the next caller retries.
 */
export class ReviewModuleCache {
	private readonly entries = new Map<string, Promise<unknown>>();

	load<T>(key: string, loader: () => Promise<T>): Promise<T> {
		const cached = this.entries.get(key) as Promise<T> | undefined;
		if (cached) {
			return cached;
		}

		let pending: Promise<T>;
		pending = Promise.resolve()
			.then(loader)
			.catch((error) => {
				if (this.entries.get(key) === pending) {
					this.entries.delete(key);
				}
				throw error;
			});
		this.entries.set(key, pending);
		return pending;
	}

	clear(): void {
		this.entries.clear();
	}
}
