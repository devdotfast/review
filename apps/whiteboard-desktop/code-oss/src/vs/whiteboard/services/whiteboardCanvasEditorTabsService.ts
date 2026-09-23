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
	WhiteboardCanvasEditorInput,
	type WhiteboardCanvasEditorTarget,
} from "../browser/parts/canvas/whiteboardCanvasEditorInput.js";

import type { WhiteboardSourceSelection } from "../common/whiteboardProtocol.js";
import { sourceSelectionIdentity } from "../common/whiteboardSourceView.js";

export const IWhiteboardCanvasEditorTabsService = createDecorator<IWhiteboardCanvasEditorTabsService>(
	"whiteboardCanvasEditorTabsService",
);

export interface IWhiteboardCanvasEditorTabsService {
	readonly _serviceBrand: undefined;
	inputFor(target: Extract<WhiteboardCanvasEditorTarget, { kind: "api" | "api-source" | "home" }>): WhiteboardCanvasEditorInput;
	openApiWhiteboard(sessionId: string, title: string, active?: boolean): Promise<WhiteboardCanvasEditorInput>;
	openApiSource(selection: WhiteboardSourceSelection, title: string): Promise<WhiteboardCanvasEditorInput>;
	openHome(active: boolean): Promise<WhiteboardCanvasEditorInput>;
	openWelcome(active: boolean): Promise<WhiteboardCanvasEditorInput>;
	openSettings(active: boolean): Promise<WhiteboardCanvasEditorInput>;
	registerWhiteboardEditor(sessionId: string, input: EditorInput): void;
	closeWhiteboard(sessionId: string): Promise<void>;
}

export class WhiteboardCanvasEditorTabsService extends Disposable implements IWhiteboardCanvasEditorTabsService {
	declare readonly _serviceBrand: undefined;

	private readonly inputs = new Map<string, WhiteboardCanvasEditorInput>();
	private readonly whiteboardEditors = new Map<string, Set<EditorInput>>();

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
				queueMicrotask(() => this.pruneWhiteboardEditor(event.editor));
			}),
		);
	}

	async openHome(active: boolean): Promise<WhiteboardCanvasEditorInput> {
		const input = await this.openSingleton({ kind: "home" }, active);
		this.editorGroupsService.groups.find((group) => group.contains(input))?.stickEditor(input);
		return input;
	}

	inputFor(
		target: Extract<WhiteboardCanvasEditorTarget, { kind: "api" | "api-source" | "home" }>,
	): WhiteboardCanvasEditorInput {
		const key =
			target.kind === "home"
				? "home"
				: target.kind === "api"
					? `api:${target.sessionId}`
					: `api:${target.sessionId}:source:${sourceSelectionIdentity(target.selection)}`;
		let input = this.inputs.get(key);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(WhiteboardCanvasEditorInput, target);
			this.inputs.set(key, input);
		}
		if (target.kind !== "home") input.setApiTitle(target.title);
		return input;
	}

	async openApiWhiteboard(sessionId: string, title: string, active = true): Promise<WhiteboardCanvasEditorInput> {
		const input = this.inputFor({ kind: "api", sessionId, title });
		await this.openWhiteboardInput(input, active);
		return input;
	}

	openWelcome(active: boolean): Promise<WhiteboardCanvasEditorInput> {
		return this.openSingleton({ kind: "welcome" }, active);
	}

	async openApiSource(selection: WhiteboardSourceSelection, title: string): Promise<WhiteboardCanvasEditorInput> {
		const input = this.inputFor({ kind: "api-source", sessionId: selection.sessionId, selection, title });
		await this.openWhiteboardInput(input, true);
		return input;
	}

	openSettings(active: boolean): Promise<WhiteboardCanvasEditorInput> {
		return this.openSingleton({ kind: "settings" }, active);
	}

	/** One tab per non-review kind; `configure` runs before the tab opens. */
	private async openSingleton(
		target: { kind: "home" } | { kind: "welcome" } | { kind: "settings" },
		active: boolean,
		configure?: (input: WhiteboardCanvasEditorInput) => void,
	): Promise<WhiteboardCanvasEditorInput> {
		let input = this.inputs.get(target.kind);
		if (!input || input.isDisposed()) {
			input = this.instantiationService.createInstance(WhiteboardCanvasEditorInput, target);
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

	private async openWhiteboardInput(input: WhiteboardCanvasEditorInput, active: boolean): Promise<void> {
		// A control command may arrive while an Ask's loading pane has focus.
		// Reuse the review's group instead of mounting a second canvas there.
		const existingGroup = this.editorGroupsService.groups.find((group) => group.contains(input));
		const targetGroup = existingGroup === undefined ? this.editorGroupsService.mainPart.activeGroup : existingGroup;
		await this.editorService.openEditor(input, { pinned: true, inactive: !active, revealIfVisible: true }, targetGroup);
	}

	async closeWhiteboard(sessionId: string): Promise<void> {
		const keys = [...this.inputs.keys()].filter(
			(key) =>
				key === sessionId ||
				key === `api:${sessionId}` ||
				key.startsWith(`api:${sessionId}:source:`) ||
				key.startsWith(`${sessionId}@`),
		);
		const whiteboardInputs = keys
			.map((key) => this.inputs.get(key))
			.filter((input): input is WhiteboardCanvasEditorInput => Boolean(input && !input.isDisposed()));
		const whiteboardEditors = [...(this.whiteboardEditors.get(sessionId) ?? [])];
		for (const key of keys) this.inputs.delete(key);
		this.whiteboardEditors.delete(sessionId);
		const editors = [
			...whiteboardInputs.flatMap((input) =>
				this.editorGroupsService.groups
					.filter((group) => group.contains(input))
					.map((group) => ({ editor: input, groupId: group.id })),
			),
			...whiteboardEditors.flatMap((editor) =>
				this.editorGroupsService.groups
					.filter((group) => group.contains(editor))
					.map((group) => ({ editor, groupId: group.id })),
			),
		];
		if (editors.length === 0) return;
		await this.editorService.closeEditors(editors);
	}

	registerWhiteboardEditor(sessionId: string, input: EditorInput): void {
		let editors = this.whiteboardEditors.get(sessionId);
		if (!editors) {
			editors = new Set();
			this.whiteboardEditors.set(sessionId, editors);
		}
		editors.add(input);
	}

	private pruneWhiteboardEditor(input: EditorInput): void {
		if (this.editorGroupsService.groups.some((group) => group.contains(input))) {
			return;
		}
		for (const [sessionId, editors] of this.whiteboardEditors) {
			editors.delete(input);
			if (editors.size === 0) {
				this.whiteboardEditors.delete(sessionId);
			}
		}
	}
}
