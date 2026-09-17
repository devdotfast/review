import { URI } from "../../base/common/uri.js";
import { reviewSourceQuery, type ReviewApiSourceLocation, type ReviewSourceView } from "./reviewProtocol.js";

export const REVIEW_API_SOURCE_SCHEME = "review-api-source";

export function apiSourceUri(target: ReviewApiSourceLocation, empty = false): URI {
	const query = new URLSearchParams({ side: target.side });
	for (const [key, value] of Object.entries(reviewSourceQuery(target.view))) {
		if (value !== undefined) query.set(key, String(value));
	}
	if (target.view.selection === "current") query.set("current", "true");
	if (target.view.access === "local") query.set("live", "true");
	if (empty) query.set("empty", "true");
	return URI.from({ scheme: REVIEW_API_SOURCE_SCHEME, authority: target.view.reviewId, path: `/${target.file}`, query: query.toString() });
}

/** Also accepts persisted URIs from before source views were introduced. */
export function sourceLocation(resource: URI): ReviewApiSourceLocation {
	const query = new URLSearchParams(resource.query);
	const commit = query.get("commit") ?? undefined;
	return {
		view: Object.freeze({
			reviewId: resource.authority,
			version: Number(query.get("version")),
			generation: query.get("generation") ?? undefined,
			selection: query.has("current") || query.has("live") ? "current" : "version",
			access: query.has("live") && !commit ? "local" : "retained",
			commit,
		}),
		side: query.get("side") === "base" ? "base" : "head",
		file: resource.path.slice(1),
	};
}

export function sourceViewIdentity(view: ReviewSourceView): string {
	return `${view.reviewId}/${view.selection === "current" ? "current" : `${view.version}/${view.generation ?? ""}`}/${view.commit ?? ""}`;
}

export function sourceTreeIdentity(resource: URI): string {
	const target = sourceLocation(resource);
	return `${sourceViewIdentity(target.view)}/${target.side}/${target.file}`;
}
