/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64 } from "../../../base/common/buffer.js";
import { Emitter, Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore } from "../../../base/common/lifecycle.js";
import { type ICodeEditor, type IDiffEditor } from "../../../editor/browser/editorBrowser.js";
import { ICodeEditorService } from "../../../editor/browser/services/codeEditorService.js";
import { createDecorator } from "../../../platform/instantiation/common/instantiation.js";
import { IOpenerService } from "../../../platform/opener/common/opener.js";
import { IHostService } from "../../../workbench/services/host/browser/host.js";
import {
	type JsonValue,
	parseWhiteboardVerbRequest,
	WHITEBOARD_DISCORD_URL,
	type WhiteboardSurfaceEvent,
	type WhiteboardVerbResponse,
	type WhiteboardView,
} from "../../common/whiteboardProtocol.js";
import { IWhiteboardApiCatalogService } from "../../services/whiteboardApiCatalogService.js";
import { IWhiteboardCanvasEditorTabsService } from "../../services/whiteboardCanvasEditorTabsService.js";
import { apiSourceTarget } from "../../services/whiteboardApiSourceService.js";
import { selectedMonacoDiff } from "./whiteboardDiffSelection.js";
import { apiSelectionEvent } from "./whiteboardApiSelection.js";

export const IWhiteboardVerbsService = createDecorator<IWhiteboardVerbsService>("whiteboardVerbsService");

export interface IWhiteboardVerbsService {
	readonly _serviceBrand: undefined;
	readonly onDidEmitSurfaceEvent: Event<WhiteboardSurfaceEvent>;
	readonly onDidRequestCanvasFocus: Event<void>;
	dispatch(value: JsonValue): Promise<WhiteboardVerbResponse>;
}

export class WhiteboardVerbsService extends Disposable implements IWhiteboardVerbsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidEmitSurfaceEvent = this._register(new Emitter<WhiteboardSurfaceEvent>());
	readonly onDidEmitSurfaceEvent = this._onDidEmitSurfaceEvent.event;
	private readonly _onDidRequestCanvasFocus = this._register(new Emitter<void>());
	readonly onDidRequestCanvasFocus = this._onDidRequestCanvasFocus.event;

	private readonly selectionEditors = new Map<string, DisposableStore>();

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IWhiteboardCanvasEditorTabsService
		private readonly tabsService: IWhiteboardCanvasEditorTabsService,
		@IHostService private readonly hostService: IHostService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IWhiteboardApiCatalogService
		private readonly apiCatalog: IWhiteboardApiCatalogService,
	) {
		super();
		for (const editor of this.codeEditorService.listCodeEditors()) this.trackSelection(editor);
		for (const diff of this.codeEditorService.listDiffEditors()) this.trackDiffSelection(diff);
		this._register(this.codeEditorService.onDiffEditorAdd(diff => this.trackDiffSelection(diff)));
		this._register(this.codeEditorService.onCodeEditorAdd((editor) => this.trackSelection(editor)));
		this._register(
			this.codeEditorService.onCodeEditorRemove((editor) => {
				this.selectionEditors.get(editor.getId())?.dispose();
				this.selectionEditors.delete(editor.getId());
			}),
		);
	}

	private trackDiffSelection(diff: IDiffEditor): void {
		const subscription = diff.onDidUpdateDiff(() => {
			this.emitSelection(diff.getOriginalEditor());
			this.emitSelection(diff.getModifiedEditor());
		});
		const disposed = diff.onDidDispose(() => { subscription.dispose(); disposed.dispose(); });
		this._register(subscription);
		this._register(disposed);
	}

	private trackSelection(editor: ICodeEditor): void {
		if (this.selectionEditors.has(editor.getId())) return;
		const store = this._register(new DisposableStore());
		this.selectionEditors.set(editor.getId(), store);
		store.add(editor.onDidChangeCursorSelection(() => this.emitSelection(editor)));
		store.add(editor.onDidFocusEditorText(() => this.emitSelection(editor)));
		store.add(editor.onDidScrollChange(() => this.emitSelection(editor)));
	}

	private emitSelection(editor: ICodeEditor): void {
		if (!editor.hasTextFocus()) return;
		const model = editor.getModel();
		const selection = editor.getSelection();
		if (!model || !selection) return;
		const start = selection.getStartPosition();
		const end = selection.getEndPosition();
		const fromLine = start.lineNumber;
		const toLine = Math.max(fromLine, end.lineNumber - (end.column === 1 && end.lineNumber > fromLine ? 1 : 0));
		const rect = editor.getDomNode()?.getBoundingClientRect();
		const position = editor.getScrolledVisiblePosition(selection.getPosition());
		const anchor = rect && position ? { x: rect.left + position.left, y: rect.top + position.top } : undefined;
		const apiSelection = apiSelectionEvent(model.uri, selection, anchor);
		if (apiSelection) {
			const diff = this.codeEditorService.listDiffEditors().find(diff => diff.getOriginalEditor() === editor || diff.getModifiedEditor() === editor);
			const models = diff?.getModel();
			const changes = diff?.getLineChanges();
			if (models && changes && !selection.isEmpty()) {
				const oldSource = apiSourceTarget(models.original.uri);
				const newSource = apiSourceTarget(models.modified.uri);
				if (oldSource && newSource) apiSelection.selectedDiff = selectedMonacoDiff(
					models.original, models.modified, changes, apiSelection.sideContext, fromLine, toLine,
					new URLSearchParams(models.original.uri.query).has("empty") ? "" : oldSource.file,
					new URLSearchParams(models.modified.uri.query).has("empty") ? "" : newSource.file,
				);
			}
			this._onDidEmitSurfaceEvent.fire(apiSelection);
			return;
		}
	}

	async dispatch(value: JsonValue): Promise<WhiteboardVerbResponse> {
		try {
			const request = parseWhiteboardVerbRequest(value);
			switch (request.name) {
				case "joinDiscord":
					await this.openerService.open(WHITEBOARD_DISCORD_URL, { openExternal: true });
					break;
				case "showWhiteboardView":
					await this.showWhiteboardView(request.args.view);
					break;
				case "openSourceTree":
				case "openDiff":
				case "reveal":
				case "openWhiteboardRevision":
					throw new Error("This action requires a pinned session canvas.");
				case "focusCanvas":
					this._onDidRequestCanvasFocus.fire();
					break;
				case "captureScreenshot":
					return { ok: true, result: await this.captureScreenshot() };
				case "openWhiteboard": {
					const review = this.apiCatalog.reviews.find((review) => review.sessionId === request.args.sessionId);
					if (!review) throw new Error("Session not found.");
					await this.tabsService.openApiWhiteboard(review.sessionId, review.title, request.args.active);
					break;
				}
				case "openApiWhiteboard":
					await this.tabsService.openApiWhiteboard(request.args.sessionId, request.args.title);
					break;
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async captureScreenshot(): Promise<{ dataUrl: string } | undefined> {
		try {
			const screenshot = await this.hostService.getScreenshot();
			if (!screenshot) return undefined;
			return {
				dataUrl: `data:image/jpeg;base64,${encodeBase64(screenshot)}`,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * The dispatcher reveals the Review tab before asking the app to show a view.
	 */
	private async showWhiteboardView(view: WhiteboardView): Promise<void> {
		this._onDidRequestCanvasFocus.fire();
		this._onDidEmitSurfaceEvent.fire({ event: "showWhiteboardView", view });
	}
}
