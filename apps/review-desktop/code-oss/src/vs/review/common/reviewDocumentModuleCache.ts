/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export class ReviewDocumentModuleCache {
	private readonly entries = new Map<string, Promise<unknown>>();

	load<T>(
		moduleUrl: string,
		runtimeUrl: string,
		loader: () => Promise<T>,
	): Promise<T> {
		const key = JSON.stringify([moduleUrl, runtimeUrl]);
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
}
