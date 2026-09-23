import { URI } from "../../base/common/uri.js";
import { whiteboardSourcePinsFromQuery, whiteboardSourceQuery, type WhiteboardApiSourceLocation, type WhiteboardSourceSelection } from "./whiteboardProtocol.js";

export const WHITEBOARD_API_SOURCE_SCHEME = "review-api-source";

export function apiSourceUri(target: WhiteboardApiSourceLocation, empty = false): URI {
	const query = new URLSearchParams({ side: target.side });
	for (const [key, value] of Object.entries(whiteboardSourceQuery(target.view))) {
		if (value !== undefined) query.set(key, String(value));
	}
	if (target.view.generation) query.set("generation", target.view.generation);
	if (empty) query.set("empty", "true");
	return URI.from({ scheme: WHITEBOARD_API_SOURCE_SCHEME, authority: target.view.sessionId, path: `/${target.file}`, query: query.toString() });
}

/** Decode resolved read coordinates; generation only separates client models. */
export function sourceLocation(resource: URI): WhiteboardApiSourceLocation {
	const query = new URLSearchParams(resource.query);
	const commit = query.get("commit") ?? undefined;
	return {
		view: Object.freeze({
			sessionId: resource.authority,
			version: Number(query.get("version")),
			generation: query.get("generation") ?? undefined,
			commit,
			pins: whiteboardSourcePinsFromQuery((key) => query.get(key)),
		}),
		side: query.get("side") === "base" ? "base" : "head",
		file: resource.path.slice(1),
	};
}

/** Tabs and directory nodes keep intent, never a resolved refresh token. */
export const WHITEBOARD_API_TREE_SCHEME = "review-api-tree";

export function sourceSelectionIdentity(selection: WhiteboardSourceSelection): string {
	return `${selection.sessionId}/${selection.kind === "current" ? "current" : selection.version}`;
}

export function sourceTreeUri(selection: WhiteboardSourceSelection, file = ""): URI {
	return URI.from({ scheme: WHITEBOARD_API_TREE_SCHEME, authority: selection.sessionId,
		path: `/${file}`, query: selection.kind === "version" ? `version=${selection.version}` : "" });
}

export function sourceTreeSelection(resource: URI): WhiteboardSourceSelection {
	const version = new URLSearchParams(resource.query).get("version");
	return version === null ? { sessionId: resource.authority, kind: "current" }
		: { sessionId: resource.authority, kind: "version", version: Number(version) };
}

/** An open Source tab owns the tree while its files change revisions. */
export function sourceTreeRoot(resource: URI, current?: URI): URI {
	if (current && resource.authority === current.authority) {
		const selection = sourceTreeSelection(current);
		if (selection.kind === "current" || selection.version === sourceLocation(resource).view.version) return current;
	}
	return sourceTreeUri({ sessionId: resource.authority, kind: "version", version: sourceLocation(resource).view.version });
}
