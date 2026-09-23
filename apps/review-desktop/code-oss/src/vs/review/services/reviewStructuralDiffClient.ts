import { decodeReviewStructuralDiffEvent, reviewSourceQuery, type ReviewSourceView } from "../common/reviewProtocol.js";
import type { StructuralEvent } from "../common/reviewStructuralDiff.js";
import type { IReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

/** The transport seam: callers consume records, never Response objects or byte chunks. */
export interface StructuralDiffStream {
	streamComparison(signal: AbortSignal): AsyncIterable<StructuralEvent>;
}

export class StructuralDiffClient implements StructuralDiffStream {
	constructor(private readonly connection: IReviewDesktopConnectionService, private readonly comparison: ReviewSourceView) { }

	async *streamComparison(signal: AbortSignal): AsyncGenerator<StructuralEvent> {
		const { serverUrl, token } = await this.connection.getConnection();
		signal.throwIfAborted();
		const query = new URLSearchParams(Object.entries(reviewSourceQuery(this.comparison)).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
		const response = await fetch(`${serverUrl}/sessions-api/${encodeURIComponent(this.comparison.sessionId)}/structural-diff?${query}`, {
			headers: { "x-whiteboard-token": token }, signal,
		});
		if (!response.ok) throw new Error((await response.json()).error ?? "Structural diff request failed.");
		if (!response.body || !response.headers.get("content-type")?.includes("ndjson")) {
			await response.body?.cancel();
			throw new Error("The Whiteboard host must be updated to stream structural diffs.");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const chunk = await reader.read();
				buffer += decoder.decode(chunk.value, { stream: !chunk.done });
				const lines = buffer.split("\n");
				buffer = lines.pop()!;
				if (chunk.done && buffer.trim()) { lines.push(buffer); buffer = ""; }
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = decodeReviewStructuralDiffEvent(line);
					if (event.type === "error") throw new Error(event.message);
					yield event;
				}
				if (chunk.done) break;
			}
		} finally {
			await reader.cancel().catch(() => { });
			reader.releaseLock();
		}
	}
}
