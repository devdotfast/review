import type { URI } from "../../../base/common/uri.js";
import type { Selection } from "../../../editor/common/core/selection.js";
import type { WhiteboardSurfaceEvent } from "../../common/whiteboardProtocol.js";
import { apiSourceTarget } from "../../services/whiteboardApiSourceService.js";

/** API-backed editors carry their pins in the URI and have no legacy session. */
export function apiSelectionEvent(
	resource: URI,
	selection: Selection,
	anchor?: { x: number; y: number },
): Extract<WhiteboardSurfaceEvent, { event: "editorSelectionChanged" }> | undefined {
	const source = apiSourceTarget(resource);
	if (!source || new URLSearchParams(resource.query).has("empty")) return undefined;
	const start = selection.getStartPosition();
	const end = selection.getEndPosition();
	const apiSource: NonNullable<Extract<WhiteboardSurfaceEvent, { event: "editorSelectionChanged" }>["apiSource"]> = {
		sessionId: source.view.sessionId, version: source.view.version, commit: source.view.commit,
	};
	// A source at its own pins says so; one that inherits carries no pins key.
	if (source.view.pins) apiSource.pins = source.view.pins;
	return {
		event: "editorSelectionChanged", sessionId: source.view.sessionId, anchor,
		path: source.file, sideContext: source.side, isEmpty: selection.isEmpty(),
		range: {
			fromLine: start.lineNumber,
			toLine: Math.max(start.lineNumber, end.lineNumber - (end.column === 1 && end.lineNumber > start.lineNumber ? 1 : 0)),
		},
		apiSource,
	};
}
