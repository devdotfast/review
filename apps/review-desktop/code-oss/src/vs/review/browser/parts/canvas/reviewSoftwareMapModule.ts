/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from "../../../../base/browser/trustedTypes.js";
import type { ReviewDesktopSession } from "../../../services/reviewSessionModelService.js";

export type ReviewSoftwareMapImporter = (url: string) => Promise<unknown>;

const softwareMapModules = new Map<string, Promise<unknown>>();
const softwareMapPolicy = createTrustedTypesPolicy("reviewSoftwareMapModule", {
	createScriptURL: (value: string) => value,
});

export async function loadReviewSoftwareMapModules(
	session: ReviewDesktopSession,
	headModuleUrl: string,
	baseModuleUrl: string,
	importModule: ReviewSoftwareMapImporter = importBlobSoftwareMapModule,
): Promise<unknown> {
	const [head, base] = await Promise.all([
		loadSoftwareMapModule(session, headModuleUrl, importModule),
		loadSoftwareMapModule(session, baseModuleUrl, importModule),
	]);
	return { head: unwrapDefault(head), base: unwrapDefault(base) };
}

function loadSoftwareMapModule(
	session: ReviewDesktopSession,
	moduleUrl: string,
	importModule: ReviewSoftwareMapImporter,
): Promise<unknown> {
	const url = new URL(moduleUrl, session.serverUrl);
	if (session.token) url.searchParams.set("token", session.token);
	const cacheKey = url.href;
	const cached = softwareMapModules.get(cacheKey);
	if (cached) return cached;
	const pending = fetch(url, {
		headers: session.token ? { "x-review-token": session.token } : undefined,
	})
		.then(async (response) => {
			if (!response.ok) {
				throw new Error(`Software map module returned ${response.status}.`);
			}
			const blobUrl = URL.createObjectURL(
				new Blob([await response.text()], { type: "text/javascript" }),
			);
			try {
				const trustedUrl =
					softwareMapPolicy?.createScriptURL(blobUrl) ?? blobUrl;
				return await importModule(trustedUrl as string);
			} finally {
				URL.revokeObjectURL(blobUrl);
			}
		})
		.catch((error) => {
			if (softwareMapModules.get(cacheKey) === pending) {
				softwareMapModules.delete(cacheKey);
			}
			throw error;
		});
	softwareMapModules.set(cacheKey, pending);
	return pending;
}

function unwrapDefault(module: unknown): unknown {
	if (!module || typeof module !== "object") return module;
	return (module as { default?: unknown }).default ?? module;
}

function importBlobSoftwareMapModule(url: string): Promise<unknown> {
	return import(/* webpackIgnore: true */ url);
}
