/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface WhiteboardCanvasReuseCandidate {
	readonly input: object;
	readonly readyInput: object | undefined;
	readonly model: object;
	readonly renderedModel: object | null;
	readonly modelState: "active" | "completed" | "unavailable";
}

export interface WhiteboardCanvasScrollSnapshot {
	readonly input: object;
	readonly model: object;
	readonly scrollTop: number;
}

function captureWhiteboardCanvasScrollSnapshot(
	input: object,
	model: { readonly state: "active" | "completed" | "unavailable" },
	document: Document,
): WhiteboardCanvasScrollSnapshot | undefined {
	if (model.state !== "active") return undefined;
	const region = document.querySelector<HTMLElement>(".whiteboard-view-region");
	if (!region) return undefined;
	return { input, model, scrollTop: region.scrollTop };
}

export function preserveWhiteboardCanvasScrollSnapshot(
	pending: WhiteboardCanvasScrollSnapshot | undefined,
	input: object,
	model: { readonly state: "active" | "completed" | "unavailable" },
	document: Document,
): WhiteboardCanvasScrollSnapshot | undefined {
	return pending?.input === input && pending.model === model
		? pending
		: captureWhiteboardCanvasScrollSnapshot(input, model, document);
}

export function canRestoreWhiteboardCanvasScrollSnapshot(
	snapshot: WhiteboardCanvasScrollSnapshot | undefined,
	candidate: {
		readonly input: object;
		readonly model: object;
		readonly modelState: "active" | "completed" | "unavailable";
	},
): snapshot is WhiteboardCanvasScrollSnapshot {
	return (
		candidate.modelState === "active" &&
		snapshot?.input === candidate.input &&
		snapshot.model === candidate.model
	);
}

/** Reuse only the still-ready view owned by this exact input and model. */
export function canReuseWhiteboardCanvas(
	candidate: WhiteboardCanvasReuseCandidate,
): boolean {
	return (
		candidate.modelState === "active" &&
		candidate.input === candidate.readyInput &&
		candidate.model === candidate.renderedModel
	);
}
