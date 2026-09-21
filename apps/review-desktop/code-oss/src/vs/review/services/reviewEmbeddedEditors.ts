/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Emitter } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import type { ICompositeCodeEditor } from "../../editor/common/editorCommon.js";

/** Tracks focus and retained selections for all native editors embedded in a review. */
export class ReviewEmbeddedEditors extends Disposable implements ICompositeCodeEditor {
	private readonly changed = this._register(new Emitter<ICompositeCodeEditor>());
	readonly onDidChangeActiveEditor = this.changed.event;
	private active: ICodeEditor | undefined;
	private selected: ICodeEditor | undefined;
	private static readonly documentEditors = new WeakSet<ICodeEditor>();

	get activeCodeEditor(): ICodeEditor | undefined { return this.active; }
	get selectionCodeEditor(): ICodeEditor | undefined { return this.active ?? this.selected; }
	static owns(editor: ICodeEditor): boolean { return this.documentEditors.has(editor); }
	static markDocumentEditor(editor: ICodeEditor): void { this.documentEditors.add(editor); }

	setExternalActiveEditor(editor: ICodeEditor | undefined): void {
		if (editor) this.selected = editor;
		if (this.active === editor) return;
		this.active = editor;
		this.changed.fire(this);
	}
	clearExternalActiveEditor(editor: ICodeEditor): void {
		if (this.selected === editor) this.selected = undefined;
		if (this.active === editor) this.setExternalActiveEditor(undefined);
	}
	reset(): void { this.selected = undefined; this.setExternalActiveEditor(undefined); }
}
