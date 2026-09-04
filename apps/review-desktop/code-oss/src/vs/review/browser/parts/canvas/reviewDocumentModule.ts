/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from "../../../../base/browser/trustedTypes.js";
import { ReviewModuleCache } from "../../../common/reviewModuleCache.js";
import { rewriteReviewDocumentRuntime } from "../../../common/reviewProtocol.js";
import type { ReviewDesktopSession } from "../../../services/reviewSessionModelService.js";

type ReviewDocumentImporter = (url: string) => Promise<unknown>;

const reviewDocumentPolicy = createTrustedTypesPolicy("reviewDocumentModule", {
	createScriptURL: (value: string) => value,
});
const reviewDocumentModules = new ReviewModuleCache();

export async function loadReviewDocumentModule(
	session: ReviewDesktopSession,
	moduleUrl: string,
	runtimeUrl: string,
	importModule: ReviewDocumentImporter = importBlobReviewModule,
): Promise<unknown> {
	const url = new URL(moduleUrl, session.serverUrl);
	const resolvedModuleUrl = url.href;
	const resolvedRuntimeUrl = new URL(runtimeUrl).href;
	return reviewDocumentModules.load(
		JSON.stringify([resolvedModuleUrl, resolvedRuntimeUrl]),
		async () => {
			if (session.token) {
				url.searchParams.set("token", session.token);
			}
			const response = await fetch(url, {
				headers: session.token
					? { "x-review-token": session.token }
					: undefined,
			});
			if (!response.ok) {
				throw new Error(
					`Review document module returned ${response.status}.`,
				);
			}
			const source = await response.text();
			const rewritten = rewriteReviewDocumentRuntime(
				source,
				resolvedRuntimeUrl,
			);
			// Published bundles carry no origin or token; hand the runtime this
			// session's request context before the document module evaluates.
			const runtimeModule = (await importModule(
				(reviewDocumentPolicy?.createScriptURL(resolvedRuntimeUrl) ??
					resolvedRuntimeUrl) as string,
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
				return await importModule(trustedUrl as string);
			} finally {
				URL.revokeObjectURL(blobUrl);
			}
		},
	);
}

export async function loadReviewSoftwareMaps(
	session: ReviewDesktopSession,
	headMapUrl: string,
	baseMapUrl: string,
): Promise<{ head: unknown; base: unknown }> {
	const [head, base] = await Promise.all([
		fetchReviewJson(session, headMapUrl, "Software map"),
		fetchReviewJson(session, baseMapUrl, "Software map"),
	]);
	return { head, base };
}

export async function fetchReviewJson(
	session: ReviewDesktopSession,
	url: string,
	label: string,
): Promise<unknown> {
	const target = new URL(url, session.serverUrl);
	const response = await fetch(target, {
		headers: session.token
			? { "x-review-token": session.token }
			: undefined,
	});
	if (!response.ok) {
		throw new Error(`${label} returned ${response.status}.`);
	}
	return response.json();
}

function importBlobReviewModule(url: string): Promise<unknown> {
	return import(/* webpackIgnore: true */ url);
}
