/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import type { ITextEditorOptions } from "../../platform/editor/common/editor.js";
import { createDecorator, IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../platform/log/common/log.js";
import type { EditorInput } from "../../workbench/common/editor/editorInput.js";
import { isResourceDiffEditorInput, isResourceEditorInput, type IUntypedEditorInput } from "../../workbench/common/editor.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { IHostService } from "../../workbench/services/host/browser/host.js";
import {
	ReviewCanvasEditorInput,
	type ReviewCanvasEditorTarget,
} from "../browser/parts/canvas/reviewCanvasEditorInput.js";

import { reviewSourceQuery, type ReviewSourceSelection } from "../common/reviewProtocol.js";
import { REVIEW_LANGUAGE_SOURCE_SCHEME } from "../common/reviewReadonlySource.js";
import { sourceLocation, sourceSelectionIdentity, REVIEW_API_SOURCE_SCHEME } from "../common/reviewSourceView.js";
import { IReviewDesktopConnectionService, reviewResponseError } from "./reviewDesktopConnectionService.js";

export const IReviewCanvasEditorTabsService = createDecorator<IReviewCanvasEditorTabsService>(
	"reviewCanvasEditorTabsService",
);

export interface IReviewCanvasEditorTabsService {
	readonly _serviceBrand: undefined;
	inputFor(target: Extract<ReviewCanvasEditorTarget, { kind: "api" | "api-source" | "home" }>): ReviewCanvasEditorInput;
	openApiReview(reviewId: string, title: string, active?: boolean): Promise<ReviewCanvasEditorInput>;
	openApiSource(selection: ReviewSourceSelection, title: string): Promise<void>;
	openSourceEditor(editor: IUntypedEditorInput): Promise<boolean>;
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
		@IReviewDesktopConnectionService
		private readonly desktopConnection: IReviewDesktopConnectionService,
		@IHostService private readonly host: IHostService,
		@ILogService private readonly logService: ILogService,
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

	async openApiSource(selection: ReviewSourceSelection, title: string): Promise<void> {
		const result = await this.navigatorWorkspace(selection.reviewId, selection.kind === "version" ? { version: selection.version } : {});
		await this.host.openWindow([{ workspaceUri: URI.file(result.workspacePath), label: title }], { forceNewWindow: true });
	}

	/** Hand source opens to the native workspace before Review creates an editor group. */
	async openSourceEditor(editor: IUntypedEditorInput): Promise<boolean> {
		const diff = isResourceDiffEditorInput(editor);
		const resources = diff ? [editor.original.resource, editor.modified.resource] : [isResourceEditorInput(editor) ? editor.resource : undefined];
		if (!resources.every((resource): resource is URI => !!resource && [REVIEW_API_SOURCE_SCHEME, REVIEW_LANGUAGE_SOURCE_SCHEME].includes(resource.scheme))) return false;
		const destinations = await Promise.all(resources.map(async resource => {
			const target = sourceLocation(resource);
			const local = resource.scheme === REVIEW_LANGUAGE_SOURCE_SCHEME;
			const result = await this.navigatorWorkspace(target.view.reviewId, {
				...reviewSourceQuery(target.view),
				side: target.side,
				file: local ? undefined : target.file,
				empty: new URLSearchParams(resource.query).has("empty") ? "true" : undefined,
			});
			const filePath = local ? resource.fsPath : result.filePath;
			if (!filePath) throw new Error("The navigator did not resolve the source file.");
			const selection = !diff ? (editor.options as ITextEditorOptions | undefined)?.selection : undefined;
			return {
				workspaceUri: URI.file(result.workspacePath),
				fileUri: URI.file(selection ? `${filePath}:${selection.startLineNumber}:${selection.startColumn ?? 1}` : filePath),
			};
		}));
		await this.host.openWindow([
			{ workspaceUri: destinations[destinations.length - 1].workspaceUri },
			...destinations.map(({ fileUri }) => ({ fileUri })),
		], { forceNewWindow: true, gotoLineMode: true, diffMode: diff });
		return true;
	}

	private async navigatorWorkspace(reviewId: string, values: Record<string, string | number | undefined>): Promise<{ workspacePath: string; filePath?: string }> {
		const { serverUrl, token } = await this.desktopConnection.getConnection();
		const query = new URLSearchParams(Object.entries(values).filter(([key, value]) => key !== "reviewId" && value !== undefined).map(([key, value]) => [key, String(value)]));
		const response = await fetch(`${serverUrl}/reviews-api/${encodeURIComponent(reviewId)}/navigator${query.size ? `?${query}` : ""}`, {
			method: "POST",
			headers: { "x-review-token": token },
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw await reviewResponseError(response, "Could not open the code navigator.");
		return response.json();
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
			if (target.kind === "welcome") {
				Event.once(input.onWillDispose)(() => void this.finishCliInstallUpdate());
			}
		}
		configure?.(input);
		// A control command may arrive while an Ask's loading pane has focus.
		// Reuse the review's group instead of mounting a second canvas there.
		const existingGroup = this.editorGroupsService.groups.find((group) => group.contains(input));
		const targetGroup = existingGroup === undefined ? this.editorGroupsService.mainPart.activeGroup : existingGroup;
		await this.editorService.openEditor(input, { pinned: true, inactive: !active, revealIfVisible: true }, targetGroup);
		return input;
	}

	/**
	 * Closing Welcome while it shows the update screen counts as finishing the
	 * update, so an upgrader is not sent back to it on the next launch.
	 */
	private async finishCliInstallUpdate(): Promise<void> {
		try {
			const status = await this.desktopConnection.getCliInstallStatus();
			if (status.updateNeeded) await this.desktopConnection.finishCliInstallUpdate();
		} catch (error) {
			this.logService.warn("[Whiteboard] Could not finish the CLI install update:", error);
		}
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
