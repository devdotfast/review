/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { Disposable } from "../../base/common/lifecycle.js";
import type { EditorInput } from "../../workbench/common/editor/editorInput.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { ReviewCanvasEditorInput } from "../browser/parts/canvas/reviewCanvasEditorInput.js";
import { IReviewSessionService } from "./reviewSessionService.js";
import { shortPath } from "../common/reviewPaths.js";

export const IReviewCanvasEditorTabsService =
	createDecorator<IReviewCanvasEditorTabsService>("reviewCanvasEditorTabsService");

export interface IReviewCanvasEditorTabsService {
	readonly _serviceBrand: undefined;
	openHome(active: boolean): Promise<ReviewCanvasEditorInput>;
	openWelcome(active: boolean): Promise<ReviewCanvasEditorInput>;
	openSettings(active: boolean): Promise<ReviewCanvasEditorInput>;
	/**
	 * Opens the Source tab. With a `reviewUuid`, binds the tab to that review
	 * so its activation can root the file tree at the review's pinned worktree.
	 * (Callers reveal the tree themselves: this service must not import the
	 * explorer — `reviewDiffTabs` already imports this module, and the cycle
	 * is a boot-time TDZ crash.)
	 */
	openSource(
		active: boolean,
		reviewUuid?: string,
	): Promise<ReviewCanvasEditorInput>;
	openReview(
		reviewUuid: string,
		active: boolean,
	): Promise<ReviewCanvasEditorInput>;
	openReviewRevision(
		reviewUuid: string,
		revision: string,
		sealedAt: number | undefined,
		active: boolean,
	): Promise<ReviewCanvasEditorInput>;
	openSession(
		sessionId: string,
		active: boolean,
	): Promise<ReviewCanvasEditorInput>;
	registerReviewEditor(reviewUuid: string, input: EditorInput): void;
	closeReview(reviewUuid: string): Promise<void>;
}

export class ReviewCanvasEditorTabsService
	extends Disposable
	implements IReviewCanvasEditorTabsService
{
	declare readonly _serviceBrand: undefined;

	private readonly inputs = new Map<string, ReviewCanvasEditorInput>();
	private readonly reviewEditors = new Map<string, Set<EditorInput>>();

	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
		@IReviewSessionService
		private readonly sessionService: IReviewSessionService,
	) {
		super();
		this._register(this.editorService.onDidCloseEditor((event) => {
			queueMicrotask(() => this.pruneReviewEditor(event.editor));
		}));
	}

	async openHome(active: boolean): Promise<ReviewCanvasEditorInput> {
		const group = this.editorGroupsService.mainPart.activeGroup;
		const input = await this.openSingleton({ kind: "home" }, active);
		group.stickEditor(input);
		return input;
	}

	openWelcome(active: boolean): Promise<ReviewCanvasEditorInput> {
		return this.openSingleton({ kind: "welcome" }, active);
	}

	openSettings(active: boolean): Promise<ReviewCanvasEditorInput> {
		return this.openSingleton({ kind: "settings" }, active);
	}

	openSource(
		active: boolean,
		reviewUuid?: string,
	): Promise<ReviewCanvasEditorInput> {
		return this.openSingleton({ kind: "source" }, active, (input) => {
			if (reviewUuid) {
				input.preferReview(reviewUuid);
			}
		});
	}

	/** One tab per non-review kind; `configure` runs before the tab opens. */
	private async openSingleton(
		target:
			| { kind: "home" }
			| { kind: "welcome" }
			| { kind: "settings" }
			| { kind: "source" },
		active: boolean,
		configure?: (input: ReviewCanvasEditorInput) => void,
	): Promise<ReviewCanvasEditorInput> {
		let input = this.inputs.get(target.kind);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(
				ReviewCanvasEditorInput,
				target,
			);
			this.inputs.set(target.kind, input);
		}
		configure?.(input);
		await this.editorService.openEditor(
			input,
			{ pinned: true, inactive: !active, revealIfVisible: true },
			this.editorGroupsService.mainPart.activeGroup,
		);
		return input;
	}

	async openReview(
		reviewUuid: string,
		active: boolean,
	): Promise<ReviewCanvasEditorInput> {
		const input = this.reviewInput(reviewUuid);
		await this.openReviewInput(input, active);
		return input;
	}

	async openReviewRevision(
		reviewUuid: string,
		revision: string,
		sealedAt: number | undefined,
		active: boolean,
	): Promise<ReviewCanvasEditorInput> {
		const review = this.sessionService.reviews.find(
			(candidate) => candidate.uuid === reviewUuid,
		);
		const key = `${reviewUuid}@${revision}`;
		let input = this.inputs.get(key);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(
				ReviewCanvasEditorInput,
				{
					kind: "review",
					reviewUuid,
					revision,
					sealedAt: sealedAt ?? null,
					title: review?.title ?? "",
					repoLabel: shortPath(review?.worktreePath ?? ""),
					lastPublishedAt: review?.lastPublishedAt ?? null,
				},
			);
			this.inputs.set(key, input);
		}
		await this.openReviewInput(input, active);
		return input;
	}

	private reviewInput(reviewUuid: string): ReviewCanvasEditorInput {
		/* The tutorial Review is not in the store-backed list; its descriptor
		   comes from the tutorial open response instead. */
		const review =
			this.sessionService.reviews.find(
				(candidate) => candidate.uuid === reviewUuid,
			) ??
			(this.sessionService.tutorialReview?.uuid === reviewUuid
				? this.sessionService.tutorialReview
				: undefined);
		const reviewError = this.sessionService.reviewErrors.find(
			(candidate) => candidate.reviewUuid === reviewUuid,
		);
		if (!review && !reviewError) {
			throw new Error(`Review descriptor is unavailable for ${reviewUuid}.`);
		}
		let input = this.inputs.get(reviewUuid);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(
				ReviewCanvasEditorInput,
					{
						kind: "review",
						reviewUuid,
						title: review?.title ?? reviewError?.title ?? "",
						repoLabel: shortPath(
							review?.worktreePath ?? reviewError?.worktreePath ?? "",
						),
						lastPublishedAt:
							review?.lastPublishedAt ?? reviewError?.lastPublishedAt ?? null,
				},
			);
			this.inputs.set(reviewUuid, input);
		}
		return input;
	}

	private async openReviewInput(
		input: ReviewCanvasEditorInput,
		active: boolean,
	): Promise<void> {
		await this.editorService.openEditor(
			input,
			{ pinned: true, inactive: !active, revealIfVisible: true },
			this.editorGroupsService.mainPart.activeGroup,
		);
	}

	async closeReview(reviewUuid: string): Promise<void> {
		const keys = [...this.inputs.keys()].filter(
			(key) => key === reviewUuid || key.startsWith(`${reviewUuid}@`),
		);
		const reviewInputs = keys
			.map((key) => this.inputs.get(key))
			.filter(
				(input): input is ReviewCanvasEditorInput =>
					Boolean(input && !input.isDisposed()),
			);
		// A Source tab bound to this review goes with it: it would only show
		// "Worktree unavailable" from here on, and closing it disposes the
		// input, which releases the background session lease.
		const source = this.inputs.get("source");
		if (
			source &&
			!source.isDisposed() &&
			source.preferredReview === reviewUuid
		) {
			reviewInputs.push(source);
		}
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
		await this.editorService.closeEditors(
			editors,
		);
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

	async openSession(
		sessionId: string,
		active: boolean,
	): Promise<ReviewCanvasEditorInput> {
		let session = this.sessionService.sessions.find(
			(candidate) => candidate.sessionId === sessionId,
		);
		if (!session) {
			await this.sessionService.refresh();
			session = this.sessionService.sessions.find(
				(candidate) => candidate.sessionId === sessionId,
			);
		}
		if (!session) {
			throw new Error(`Review session is unavailable: ${sessionId}`);
		}
		const input = session.historicalRevision
			? await this.openReviewRevision(
				session.reviewUuid,
				session.historicalRevision,
				undefined,
				false,
			)
			: this.reviewInput(session.reviewUuid);
		input.preferSession(sessionId);
		await this.openReviewInput(input, active);
		return input;
	}
}

