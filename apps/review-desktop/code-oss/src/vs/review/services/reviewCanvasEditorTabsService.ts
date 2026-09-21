/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../base/common/lifecycle.js";
import { createDecorator, IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import type { EditorInput } from "../../workbench/common/editor/editorInput.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import {
	ReviewCanvasEditorInput,
	type ReviewCanvasEditorTarget,
} from "../browser/parts/canvas/reviewCanvasEditorInput.js";

import type { ReviewSourceSelection } from "../common/reviewProtocol.js";
import { sourceSelectionIdentity } from "../common/reviewSourceView.js";

export const IReviewCanvasEditorTabsService = createDecorator<IReviewCanvasEditorTabsService>(
	"reviewCanvasEditorTabsService",
);

export interface IReviewCanvasEditorTabsService {
	readonly _serviceBrand: undefined;
	inputFor(target: Extract<ReviewCanvasEditorTarget, { kind: "api" | "api-source" | "home" }>): ReviewCanvasEditorInput;
	openApiReview(reviewId: string, title: string, active?: boolean): Promise<ReviewCanvasEditorInput>;
	openApiSource(selection: ReviewSourceSelection, title: string): Promise<ReviewCanvasEditorInput>;
	openHome(active: boolean): Promise<ReviewCanvasEditorInput>;
	openWelcome(active: boolean): Promise<ReviewCanvasEditorInput>;
	openSettings(active: boolean): Promise<ReviewCanvasEditorInput>;
	registerReviewEditor(reviewUuid: string, input: EditorInput): void;
	closeReview(reviewUuid: string): Promise<void>;
}

export class ReviewCanvasEditorTabsService extends Disposable implements IReviewCanvasEditorTabsService {
	declare readonly _serviceBrand: undefined;

	private readonly inputs = new Map<string, ReviewCanvasEditorInput>();
	private readonly reviewEditors = new Map<string, Set<EditorInput>>();

	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this._register(
			this.editorService.onDidCloseEditor((event) => {
				queueMicrotask(() => this.pruneReviewEditor(event.editor));
			}),
		);
	}

	async openHome(active: boolean): Promise<ReviewCanvasEditorInput> {
		const input = await this.openSingleton({ kind: "home" }, active);
		this.editorGroupsService.groups.find((group) => group.contains(input))?.stickEditor(input);
		return input;
	}

	inputFor(
		target: Extract<ReviewCanvasEditorTarget, { kind: "api" | "api-source" | "home" }>,
	): ReviewCanvasEditorInput {
		const key =
			target.kind === "home"
				? "home"
				: target.kind === "api"
					? `api:${target.reviewId}`
					: `api:${target.reviewId}:source:${sourceSelectionIdentity(target.selection)}`;
		let input = this.inputs.get(key);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(ReviewCanvasEditorInput, target);
			this.inputs.set(key, input);
		}
		if (target.kind !== "home") input.setApiTitle(target.title);
		return input;
	}

	async openApiReview(reviewId: string, title: string, active = true): Promise<ReviewCanvasEditorInput> {
		const input = this.inputFor({ kind: "api", reviewId, title });
		await this.openReviewInput(input, active);
		return input;
	}

	openWelcome(active: boolean): Promise<ReviewCanvasEditorInput> {
		return this.openSingleton({ kind: "welcome" }, active);
	}

	async openApiSource(selection: ReviewSourceSelection, title: string): Promise<ReviewCanvasEditorInput> {
		const input = this.inputFor({ kind: "api-source", reviewId: selection.reviewId, selection, title });
		await this.openReviewInput(input, true);
		return input;
	}

	openSettings(active: boolean): Promise<ReviewCanvasEditorInput> {
		return this.openSingleton({ kind: "settings" }, active);
	}

	/** One tab per non-review kind; `configure` runs before the tab opens. */
	private async openSingleton(
		target: { kind: "home" } | { kind: "welcome" } | { kind: "settings" },
		active: boolean,
		configure?: (input: ReviewCanvasEditorInput) => void,
	): Promise<ReviewCanvasEditorInput> {
		let input = this.inputs.get(target.kind);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(ReviewCanvasEditorInput, target);
			this.inputs.set(target.kind, input);
		}
		configure?.(input);
		// A control command may arrive while an Ask's loading pane has focus.
		// Reuse the review's group instead of mounting a second canvas there.
		const existingGroup = this.editorGroupsService.groups.find((group) => group.contains(input));
		const targetGroup = existingGroup === undefined ? this.editorGroupsService.mainPart.activeGroup : existingGroup;
		await this.editorService.openEditor(input, { pinned: true, inactive: !active, revealIfVisible: true }, targetGroup);
		return input;
	}

	private async openReviewInput(input: ReviewCanvasEditorInput, active: boolean): Promise<void> {
		// A control command may arrive while an Ask's loading pane has focus.
		// Reuse the review's group instead of mounting a second canvas there.
		const existingGroup = this.editorGroupsService.groups.find((group) => group.contains(input));
		const targetGroup = existingGroup === undefined ? this.editorGroupsService.mainPart.activeGroup : existingGroup;
		await this.editorService.openEditor(input, { pinned: true, inactive: !active, revealIfVisible: true }, targetGroup);
	}

	async closeReview(reviewUuid: string): Promise<void> {
		const keys = [...this.inputs.keys()].filter(
			(key) =>
				key === reviewUuid ||
				key === `api:${reviewUuid}` ||
				key.startsWith(`api:${reviewUuid}:source:`) ||
				key.startsWith(`${reviewUuid}@`),
		);
		const reviewInputs = keys
			.map((key) => this.inputs.get(key))
			.filter((input): input is ReviewCanvasEditorInput => Boolean(input && !input.isDisposed()));
		const reviewEditors = [...(this.reviewEditors.get(reviewUuid) ?? [])];
		for (const key of keys) this.inputs.delete(key);
		this.reviewEditors.delete(reviewUuid);
		const editors = [
			...reviewInputs.flatMap((input) =>
				this.editorGroupsService.groups
					.filter((group) => group.contains(input))
					.map((group) => ({ editor: input, groupId: group.id })),
			),
			...reviewEditors.flatMap((editor) =>
				this.editorGroupsService.groups
					.filter((group) => group.contains(editor))
					.map((group) => ({ editor, groupId: group.id })),
			),
		];
		if (editors.length === 0) return;
		await this.editorService.closeEditors(editors);
	}

	registerReviewEditor(reviewUuid: string, input: EditorInput): void {
		let editors = this.reviewEditors.get(reviewUuid);
		if (!editors) {
			editors = new Set();
			this.reviewEditors.set(reviewUuid, editors);
		}
		editors.add(input);
	}

	private pruneReviewEditor(input: EditorInput): void {
		if (this.editorGroupsService.groups.some((group) => group.contains(input))) {
			return;
		}
		for (const [reviewUuid, editors] of this.reviewEditors) {
			editors.delete(input);
			if (editors.size === 0) {
				this.reviewEditors.delete(reviewUuid);
			}
		}
	}
}
