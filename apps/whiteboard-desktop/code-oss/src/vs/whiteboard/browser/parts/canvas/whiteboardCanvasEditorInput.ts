/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from "../../../../base/common/codicons.js";
import type { ThemeIcon } from "../../../../base/common/themables.js";
import { URI } from "../../../../base/common/uri.js";
import { localize } from "../../../../nls.js";
import {
	EditorInputCapabilities,
	type GroupIdentifier,
	type IUntypedEditorInput,
} from "../../../../workbench/common/editor.js";
import { EditorInput } from "../../../../workbench/common/editor/editorInput.js";
import { IEditorGroupsService } from "../../../../workbench/services/editor/common/editorGroupsService.js";

import { SCRATCHPAD_SESSION_ID, type WhiteboardSourceSelection } from "../../../common/whiteboardProtocol.js";
import { sourceSelectionIdentity } from "../../../common/whiteboardSourceView.js";

export type WhiteboardCanvasEditorTarget =
	| { readonly kind: "home" }
	| { readonly kind: "welcome" }
	| { readonly kind: "settings" }
	| {
		readonly kind: "api-source";
		readonly sessionId: string;
		readonly selection: WhiteboardSourceSelection;
		readonly title: string;
	}
	| { readonly kind: "api"; readonly sessionId: string; readonly title: string };

export class WhiteboardCanvasEditorInput extends EditorInput {
	static readonly ID = "workbench.editors.devfast.whiteboardCanvas";
	static readonly EDITOR_ID = "workbench.editor.devfast.whiteboardCanvas";

	readonly resource: URI;
	private _target: WhiteboardCanvasEditorTarget;
	constructor(
		target: WhiteboardCanvasEditorTarget,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this._target = target;
		this.resource = URI.from({
			scheme: "devfast-review-canvas",
			authority: target.kind,
			path:
				target.kind === "api-source"
					? `/${sourceSelectionIdentity(target.selection)}`
					: target.kind === "api"
						? `/${target.sessionId}`
						: `/${target.kind}`,
		});
	}

	get target(): WhiteboardCanvasEditorTarget {
		return this._target;
	}

	setApiTitle(title: string): void {
		if (this._target.kind !== "api" || this._target.title === title) return;
		this._target = { ...this._target, title };
		this._onDidChangeLabel.fire();
	}

	override get typeId(): string {
		return WhiteboardCanvasEditorInput.ID;
	}

	override get editorId(): string {
		return WhiteboardCanvasEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		let capabilities =
			EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal;
		if (this.target.kind === "home") {
			capabilities |= EditorInputCapabilities.CannotClose;
		}
		return capabilities;
	}

	override canMove(sourceGroup: GroupIdentifier, targetGroup: GroupIdentifier): true | string {
		if (
			this.target.kind === "home" &&
			this.editorGroupsService.getPart(targetGroup) !== this.editorGroupsService.mainPart
		) {
			return localize("whiteboardHomeCannotMove", "The Home tab cannot move to a separate window.");
		}
		return super.canMove(sourceGroup, targetGroup);
	}

	override getName(): string {
		if (this.target.kind === "api-source") return this.target.selection.kind === "current" ? `Source — ${this.target.title}` : `Source — ${this.target.title} (v${this.target.selection.version})`;
		if (this.target.kind === "api") return this.target.title;
		if (this.target.kind === "home") return "Home";
		if (this.target.kind === "welcome") return "Welcome";
		if (this.target.kind === "settings") return "Settings";
		return "Session";
	}

	override getIcon(): ThemeIcon | undefined {
		if (this.target.kind === "home") return Codicon.home;
		if (this.target.kind === "api-source") return Codicon.repo;
		if (this.target.kind === "api" && this.target.sessionId === SCRATCHPAD_SESSION_ID) return Codicon.edit;
		return undefined;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return (
			super.matches(other) ||
			(other instanceof WhiteboardCanvasEditorInput && other.resource.toString() === this.resource.toString())
		);
	}
}
