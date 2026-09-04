/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ReviewDocumentLoad,
	ReviewSoftwareMapLoad,
} from "../../../common/reviewProtocol.js";
import type { ReviewDesktopSession } from "../../../services/reviewSessionModelService.js";

export async function loadReviewDocumentData(
	session: ReviewDesktopSession,
	documentUrl: string,
	contentHash: string,
): Promise<ReviewDocumentLoad> {
	return {
		state: "ready",
		contentHash,
		data: await fetchReviewJson(session, documentUrl, "Review document"),
	};
}

export async function loadReviewSoftwareMaps(
	session: ReviewDesktopSession,
	headMapUrl: string,
	baseMapUrl: string,
	contentHash: string,
): Promise<ReviewSoftwareMapLoad> {
	const [head, base] = await Promise.all([
		fetchReviewJson(session, headMapUrl, "Software map"),
		fetchReviewJson(session, baseMapUrl, "Software map"),
	]);
	return { state: "ready", contentHash, head, base };
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
