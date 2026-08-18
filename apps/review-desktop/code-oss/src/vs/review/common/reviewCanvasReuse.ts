/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ReviewCanvasReuseCandidate {
	readonly input: object;
	readonly readyInput: object | undefined;
	readonly model: object;
	readonly renderedModel: object | null;
	readonly modelState: "active" | "completed" | "unavailable";
}

export interface ReviewCanvasScrollSnapshot {
	readonly input: object;
	readonly model: object;
	readonly scrollTop: number;
}

export function captureReviewCanvasScrollSnapshot(
	input: object,
	model: { readonly state: "active" | "completed" | "unavailable" },
	document: Document,
): ReviewCanvasScrollSnapshot | undefined {
	if (model.state !== "active") return undefined;
	const region = document.querySelector<HTMLElement>(".review-view-region");
	if (!region) return undefined;
	return { input, model, scrollTop: region.scrollTop };
}

export function preserveReviewCanvasScrollSnapshot(
	pending: ReviewCanvasScrollSnapshot | undefined,
	input: object,
	model: { readonly state: "active" | "completed" | "unavailable" },
	document: Document,
): ReviewCanvasScrollSnapshot | undefined {
	return pending?.input === input && pending.model === model
		? pending
		: captureReviewCanvasScrollSnapshot(input, model, document);
}

export function canRestoreReviewCanvasScrollSnapshot(
	snapshot: ReviewCanvasScrollSnapshot | undefined,
	candidate: {
		readonly input: object;
		readonly model: object;
		readonly modelState: "active" | "completed" | "unavailable";
	},
): snapshot is ReviewCanvasScrollSnapshot {
	return (
		candidate.modelState === "active" &&
		snapshot?.input === candidate.input &&
		snapshot.model === candidate.model
	);
}

/** Reuse only the still-ready view owned by this exact input and model. */
export function canReuseReviewCanvas(
	candidate: ReviewCanvasReuseCandidate,
): boolean {
	return (
		candidate.modelState === "active" &&
		candidate.input === candidate.readyInput &&
		candidate.model === candidate.renderedModel
	);
}
