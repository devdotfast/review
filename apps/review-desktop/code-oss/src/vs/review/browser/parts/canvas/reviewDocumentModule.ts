/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from "../../../../base/browser/trustedTypes.js";
import { ReviewModuleCache } from "../../../common/reviewModuleCache.js";
import { rewriteReviewDocumentRuntime } from "../../../common/reviewProtocol.js";
import type { ReviewDesktopSession } from "../../../services/reviewSessionModelService.js";

type ReviewDocumentImporter = (url: string) => Promise<unknown>;

const softwareMapModules = new ReviewModuleCache();

const reviewDocumentPolicy = createTrustedTypesPolicy("reviewDocumentModule", {
	createScriptURL: (value: string) => value,
});
const reviewDocumentModules = new ReviewModuleCache();

export type ReviewDocumentLoadStep = (
	name: string,
	startEpochMs: number,
	endEpochMs: number,
) => void;

export async function loadReviewDocumentModule(
	session: ReviewDesktopSession,
	moduleUrl: string,
	runtimeUrl: string,
	importModule: ReviewDocumentImporter = importBlobReviewModule,
	onStep?: ReviewDocumentLoadStep,
): Promise<unknown> {
	const url = new URL(moduleUrl, session.serverUrl);
	const resolvedModuleUrl = url.href;
	const resolvedRuntimeUrl = new URL(runtimeUrl).href;
	const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const startEpochMs = Date.now();
		try {
			return await fn();
		} finally {
			onStep?.(name, startEpochMs, Date.now());
		}
	};
	return reviewDocumentModules.load(
		JSON.stringify([resolvedModuleUrl, resolvedRuntimeUrl]),
		async () => {
			if (session.token) {
				url.searchParams.set("token", session.token);
			}
			const response = await timed("module: fetch bundle", () =>
				fetch(url, {
					headers: session.token
						? { "x-review-token": session.token }
						: undefined,
				}),
			);
			if (!response.ok) {
				throw new Error(
					`Review document module returned ${response.status}.`,
				);
			}
			const source = await timed("module: read body", () => response.text());
			const rewritten = rewriteReviewDocumentRuntime(
				source,
				resolvedRuntimeUrl,
			);
			// Published bundles carry no origin or token; hand the runtime this
			// session's request context before the document module evaluates.
			const runtimeModule = (await timed("module: import runtime", () =>
				importModule(
					(reviewDocumentPolicy?.createScriptURL(resolvedRuntimeUrl) ??
						resolvedRuntimeUrl) as string,
				),
			)) as {
				setReviewRequestContext?: (context: {
					origin?: string;
					token?: string;
				}) => void;
			};
			runtimeModule.setReviewRequestContext?.({
				origin: session.sessionUrl,
				token: session.token,
			});
			const blobUrl = URL.createObjectURL(
				new Blob([rewritten], { type: "text/javascript" }),
			);
			try {
				const trustedUrl =
					reviewDocumentPolicy?.createScriptURL(blobUrl) ?? blobUrl;
				return await timed("module: import document", () =>
					importModule(trustedUrl as string),
				);
			} finally {
				URL.revokeObjectURL(blobUrl);
			}
		},
	);
}

export async function loadReviewSoftwareMapModules(
	session: ReviewDesktopSession,
	headModuleUrl: string,
	baseModuleUrl: string,
	importModule: ReviewDocumentImporter = importBlobReviewModule,
): Promise<unknown> {
	const [head, base] = await Promise.all([
		loadSoftwareMapModule(session, headModuleUrl, importModule),
		loadSoftwareMapModule(session, baseModuleUrl, importModule),
	]);
	return {
		head: unwrapDefault(head),
		base: unwrapDefault(base),
	};
}

function loadSoftwareMapModule(
	session: ReviewDesktopSession,
	moduleUrl: string,
	importModule: ReviewDocumentImporter,
): Promise<unknown> {
	const url = new URL(moduleUrl, session.serverUrl);
	if (session.token) url.searchParams.set("token", session.token);
	return softwareMapModules.load(url.href, async () => {
		const response = await fetch(url, {
			headers: session.token
				? { "x-review-token": session.token }
				: undefined,
		});
		if (!response.ok) {
			throw new Error(`Software map module returned ${response.status}.`);
		}
		const blobUrl = URL.createObjectURL(
			new Blob([await response.text()], { type: "text/javascript" }),
		);
		try {
			const trustedUrl =
				reviewDocumentPolicy?.createScriptURL(blobUrl) ?? blobUrl;
			return await importModule(trustedUrl as string);
		} finally {
			URL.revokeObjectURL(blobUrl);
		}
	});
}

function unwrapDefault(module: unknown): unknown {
	if (!module || typeof module !== "object") return module;
	return (module as { default?: unknown }).default ?? module;
}

function importBlobReviewModule(url: string): Promise<unknown> {
	return import(/* webpackIgnore: true */ url);
}
