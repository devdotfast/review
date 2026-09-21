import type { URI } from "../../../base/common/uri.js";
import type { Selection } from "../../../editor/common/core/selection.js";
import type { ReviewSurfaceEvent } from "../../common/reviewProtocol.js";
import { apiSourceTarget } from "../../services/reviewApiSourceService.js";

/** API-backed editors carry their pins in the URI and have no legacy session. */
export function apiSelectionEvent(
	resource: URI,
	selection: Selection,
	anchor?: { x: number; y: number },
): Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }> | undefined {
	const source = apiSourceTarget(resource);
	if (!source || new URLSearchParams(resource.query).has("empty")) return undefined;
	const start = selection.getStartPosition();
	const end = selection.getEndPosition();
	return {
		event: "editorSelectionChanged", reviewId: source.view.reviewId, anchor,
		path: source.file, sideContext: source.side, isEmpty: selection.isEmpty(),
		range: {
			fromLine: start.lineNumber,
			toLine: Math.max(start.lineNumber, end.lineNumber - (end.column === 1 && end.lineNumber > start.lineNumber ? 1 : 0)),
		},
		apiSource: { reviewId: source.view.reviewId, version: source.view.version, commit: source.view.commit },
	};
}
