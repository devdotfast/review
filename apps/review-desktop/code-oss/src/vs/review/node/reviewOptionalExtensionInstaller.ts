/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// src/main.ts imports this module before bootstrapESM() installs the NLS table.
// Keep it limited to Node modules and the import-free catalog.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { reviewOptionalExtensionCatalog } from './reviewOptionalExtensionCatalog.js';

const DOWNLOAD_CHANNEL = 'vscode:reviewDownloadOptionalExtension';
const MAX_REDIRECTS = 10;

type ReviewNetResponse = Readable & {
	readonly statusCode: number;
	readonly statusMessage?: string;
	readonly headers: Readonly<Record<string, string | readonly string[]>>;
};

export interface ReviewNetRequest {
	on(event: 'redirect', listener: (
		statusCode: number,
		method: string,
		redirectUrl: string,
		responseHeaders: Readonly<Record<string, string | readonly string[]>>
	) => void): this;
	once(event: 'response', listener: (response: ReviewNetResponse) => void): this;
	once(event: 'error', listener: (error: Error) => void): this;
	followRedirect(): void;
	abort(): void;
	end(): void;
}

export type ReviewNetRequestFactory = (options: {
	readonly method: 'GET';
	readonly url: string;
	readonly redirect: 'manual';
}) => unknown;

export interface ReviewValidatedIpcMain {
	handle(channel: string, listener: (event: unknown, extensionId: unknown) => Promise<string>): unknown;
}

export interface ReviewOptionalExtensionInstallerOptions {
	readonly userDataPath: string;
	readonly platform: NodeJS.Platform | string;
	readonly arch: string;
	readonly request: ReviewNetRequestFactory;
	readonly catalog?: readonly ReviewOptionalExtensionCatalogEntry[];
}

export interface ReviewOptionalExtensionTargetPin {
	readonly url: string;
	readonly sha256: string;
	readonly size: number;
}

export interface ReviewOptionalExtensionCatalogEntry {
	readonly id: string;
	readonly role: 'primary' | 'support';
	readonly group: string;
	readonly version: string;
	readonly targets: Readonly<Record<string, ReviewOptionalExtensionTargetPin>>;
}

function supportedTarget(platform: string, arch: string): 'darwin-arm64' | 'linux-x64' | undefined {
	if (platform === 'darwin' && arch === 'arm64') {
		return 'darwin-arm64';
	}
	if (platform === 'linux' && arch === 'x64') {
		return 'linux-x64';
	}
	return undefined;
}

async function sha256File(file: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

async function isFile(file: string): Promise<boolean> {
	try {
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}

export class ReviewOptionalExtensionInstaller {
	private readonly cacheDirectory: string;
	private readonly inflight = new Map<string, Promise<string>>();
	private readonly catalog: readonly ReviewOptionalExtensionCatalogEntry[];

	constructor(private readonly options: ReviewOptionalExtensionInstallerOptions) {
		this.cacheDirectory = path.resolve(options.userDataPath, 'optional-extensions', 'cache');
		this.catalog = options.catalog ?? reviewOptionalExtensionCatalog;
	}

	async download(extensionId: string): Promise<string> {
		const extension = this.catalog.find(candidate => candidate.id === extensionId);
		if (!extension) {
			throw new Error(`Unknown optional extension: ${extensionId}`);
		}

		const target = supportedTarget(this.options.platform, this.options.arch);
		if (!target) {
			throw new Error(`Optional extensions do not support ${this.options.platform}/${this.options.arch}`);
		}
		const targetPin = extension.targets['universal'] ?? extension.targets[target];
		if (!targetPin) {
			throw new Error(`${extension.id} has no optional extension pin for ${target}`);
		}

		const targetKey = extension.targets['universal'] ? 'universal' : target;
		const inflightKey = `${extension.id}@${extension.version}:${targetKey}`;
		const existing = this.inflight.get(inflightKey);
		if (existing) {
			return existing;
		}

		const pending = this.ensureVerifiedVsix(extension.id, extension.version, targetKey, targetPin);
		this.inflight.set(inflightKey, pending);
		try {
			return await pending;
		} finally {
			if (this.inflight.get(inflightKey) === pending) {
				this.inflight.delete(inflightKey);
			}
		}
	}

	private async ensureVerifiedVsix(
		extensionId: string,
		version: string,
		target: string,
		pin: { readonly url: string; readonly sha256: string; readonly size: number }
	): Promise<string> {
		await mkdir(this.cacheDirectory, { recursive: true });
		const suffix = target === 'universal' ? '' : `@${target}`;
		const cached = path.resolve(this.cacheDirectory, `${extensionId}-${version}${suffix}.vsix`);

		if (await isFile(cached)) {
			if (await sha256File(cached) === pin.sha256) {
				return cached;
			}
			await rm(cached, { force: true });
		}

		const partial = `${cached}.${process.pid}.${randomUUID()}.part`;
		try {
			const actualHash = await this.downloadToPartial(pin.url, partial);
			if (actualHash !== pin.sha256) {
				throw new Error(
					`${extensionId} checksum mismatch: expected ${pin.sha256}, received ${actualHash}`
				);
			}
			await rename(partial, cached);
			return cached;
		} catch (error) {
			await rm(partial, { force: true });
			throw error;
		}
	}

	private async downloadToPartial(initialUrl: string, partial: string): Promise<string> {
		const response = await this.request(initialUrl);
		if (response.statusCode !== 200) {
			response.resume();
			throw new Error(`GET ${initialUrl} failed with ${response.statusCode} ${response.statusMessage ?? ''}`.trim());
		}

		const hash = createHash('sha256');
		const hashingStream = new Transform({
			transform(chunk, _encoding, callback) {
				hash.update(chunk);
				callback(null, chunk);
			}
		});
		await pipeline(response, hashingStream, createWriteStream(partial, { flags: 'wx' }));
		return hash.digest('hex');
	}

	private request(initialUrl: string): Promise<ReviewNetResponse> {
		return new Promise((resolve, reject) => {
			const request = this.options.request({ method: 'GET', url: initialUrl, redirect: 'manual' }) as ReviewNetRequest;
			let redirects = 0;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				reject(error);
				request.abort();
			};
			request.on('redirect', (_statusCode, method, redirectUrl) => {
				redirects++;
				if (redirects > MAX_REDIRECTS) {
					fail(new Error(`GET ${initialUrl} exceeded ${MAX_REDIRECTS} redirects`));
					return;
				}
				const redirected = new URL(redirectUrl);
				if (method !== 'GET') {
					fail(new Error(`Refused optional extension redirect with method ${method}`));
					return;
				}
				if (redirected.protocol !== 'https:') {
					fail(new Error(`Refused optional extension redirect to ${redirected.protocol}`));
					return;
				}
				// Electron cancels a manual redirect unless this call happens inside
				// the redirect event. Validate first, then follow it synchronously.
				request.followRedirect();
			});
			request.once('response', response => {
				if (!settled) {
					settled = true;
					resolve(response);
				} else {
					response.resume();
				}
			});
			request.once('error', error => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			});
			request.end();
		});
	}
}

export function registerReviewOptionalExtensionInstaller(
	ipcMain: ReviewValidatedIpcMain,
	options: ReviewOptionalExtensionInstallerOptions
): ReviewOptionalExtensionInstaller {
	const installer = new ReviewOptionalExtensionInstaller(options);
	ipcMain.handle(DOWNLOAD_CHANNEL, async (_event, extensionId) => {
		if (typeof extensionId !== 'string' || extensionId.length === 0) {
			throw new Error('Optional extension downloads require one extension ID');
		}
		return installer.download(extensionId);
	});
	return installer;
}
