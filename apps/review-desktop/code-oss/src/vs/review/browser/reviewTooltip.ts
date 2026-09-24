/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from "../../base/browser/dom.js";
import type { IHoverWidget } from "../../base/browser/ui/hover/hover.js";
import { HoverPosition } from "../../base/browser/ui/hover/hoverWidget.js";
import { Disposable, MutableDisposable } from "../../base/common/lifecycle.js";
import type { IHoverService } from "../../platform/hover/browser/hover.js";
import type { ReviewDiffProgressState } from "../common/reviewProtocol.js";

/** A label line and an optional fainter second line. */
export interface ReviewTooltipContent {
	readonly label: string;
	readonly detail?: string;
}

export type ReviewTooltipHoverService = Pick<IHoverService, "showInstantHover">;

/**
 * The Whiteboard tooltip: a raised card above its target, shown the moment the
 * pointer or keyboard focus lands and gone on leave, click, scroll or key.
 * The `review-tooltip` class keeps its look off every other hover.
 */
export class ReviewTooltip extends Disposable {
	private readonly hover = this._register(new MutableDisposable<IHoverWidget>());
	private readonly scroll = this._register(new MutableDisposable());
	private current: ReviewTooltipContent | undefined;

	constructor(
		private readonly hoverService: ReviewTooltipHoverService,
		private readonly target: HTMLElement,
		content?: ReviewTooltipContent,
	) {
		super();
		this.current = content;
		this._register(addDisposableListener(target, "mouseenter", () => this.show()));
		this._register(addDisposableListener(target, "focus", () => {
			if (target.matches(":focus-visible")) this.show();
		}));
		for (const event of ["mouseleave", "blur", "pointerdown", "click", "keydown"]) {
			this._register(addDisposableListener(target, event, () => this.hide()));
		}
	}

	set content(content: ReviewTooltipContent | undefined) {
		if (content?.label === this.current?.label && content?.detail === this.current?.detail) return;
		this.current = content;
		if (this.hover.value) this.show();
	}

	private show(): void {
		this.hide();
		if (!this.current?.label) return;
		const body = $("span.review-tooltip-body");
		append(body, $("span.review-tooltip-label")).textContent = this.current.label;
		if (this.current.detail) append(body, $("span.review-tooltip-detail")).textContent = this.current.detail;
		this.hover.value = this.hoverService.showInstantHover({
			target: this.target,
			content: body,
			additionalClasses: ["review-tooltip"],
			position: { hoverPosition: HoverPosition.ABOVE },
			appearance: { compact: true, showPointer: true, skipFadeInAnimation: true },
			persistence: { hideOnHover: true, hideOnKeyDown: true },
		});
		if (this.hover.value) {
			this.scroll.value = addDisposableListener(this.target.ownerDocument, "scroll", () => this.hide(), true);
		}
	}

	private hide(): void {
		this.hover.clear();
		this.scroll.clear();
	}
}

const signedPair = (additions: number, deletions: number) => `+${additions} −${deletions}`;

/** What a diff count's tooltip says: what is left, then the whole. */
export function reviewCountsTooltip(counts: {
	readonly remaining: { readonly additions: number; readonly deletions: number };
	readonly total: { readonly additions: number; readonly deletions: number };
}): ReviewTooltipContent {
	return {
		label: `${signedPair(counts.remaining.additions, counts.remaining.deletions)} remaining`,
		detail: `of ${signedPair(counts.total.additions, counts.total.deletions)} total`,
	};
}

/** A count that has no coverage yet: the structural diff's own totals. */
export function reviewChangesTooltip(added: number, removed: number): ReviewTooltipContent {
	return { label: `${signedPair(added, removed)} changed` };
}

export const REVIEW_COUNTS_PENDING_TOOLTIP: ReviewTooltipContent = { label: "Waiting for structural coverage" };

/**
 * The one viewed checkbox: a 14px box whose dash and check are drawn in CSS,
 * with an instant tooltip saying what a click does. With nothing to view it
 * keeps its slot but hides, so the columns beside it stay aligned.
 */
export class ReviewViewedCheckbox extends Disposable {
	readonly element: HTMLButtonElement;
	private readonly tooltip: ReviewTooltip;

	constructor(hoverService: ReviewTooltipHoverService, ownerDocument: Document, onToggle: () => void) {
		super();
		this.element = ownerDocument.createElement("button");
		this.element.type = "button";
		this.element.className = "review-viewed-check";
		this.element.setAttribute("role", "checkbox");
		this.tooltip = this._register(new ReviewTooltip(hoverService, this.element));
		this._register(addDisposableListener(this.element, "click", (event) => {
			event.stopPropagation();
			onToggle();
		}));
	}

	/** `subject` names what the box marks, for screen readers. */
	update(state: ReviewDiffProgressState | undefined, subject: string, empty: boolean): void {
		const viewed = state === "viewed";
		this.element.setAttribute("aria-checked", state === "partial" ? "mixed" : String(viewed));
		this.element.setAttribute("aria-label", `${viewed ? "Mark unviewed" : "Mark viewed"}: ${subject}`);
		this.element.classList.toggle("is-empty", empty);
		this.element.disabled = empty;
		this.tooltip.content = empty ? undefined : { label: reviewViewedTooltip(state) };
	}
}

export function reviewViewedTooltip(state: ReviewDiffProgressState | undefined): string {
	return state === "viewed"
		? "Click to mark as unviewed"
		: state === "partial"
			? "Click to mark all as viewed"
			: "Click to mark as viewed";
}
