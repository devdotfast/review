import type { URI } from "../../base/common/uri.js";

export const REVIEW_LANGUAGE_SOURCE_SCHEME = "review-language-source";

/** These resources own presentation buffers, never workspace working copies. */
export function isReviewReadonlySource(resource: URI | undefined): boolean {
	return resource?.scheme === "review-api-source" || resource?.scheme === REVIEW_LANGUAGE_SOURCE_SCHEME || resource?.scheme === "devfast-review-unified";
}
