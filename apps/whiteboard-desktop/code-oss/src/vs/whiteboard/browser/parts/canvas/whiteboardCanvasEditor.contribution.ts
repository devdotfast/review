/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { EditorPaneDescriptor, IEditorPaneRegistry } from "../../../../workbench/browser/editor.js";
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from "../../../../workbench/common/contributions.js";
import {
	EditorExtensions,
	EditorResourceAccessor,
	SideBySideEditor,
	type IEditorFactoryRegistry,
} from "../../../../workbench/common/editor.js";
import { IEditorGroupsService } from "../../../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import { IWhiteboardApiCatalogService } from "../../../services/whiteboardApiCatalogService.js";
import { IWhiteboardCanvasEditorTabsService } from "../../../services/whiteboardCanvasEditorTabsService.js";
import { IWhiteboardDesktopConnectionService } from "../../../services/whiteboardDesktopConnectionService.js";
import { WhiteboardApiEditorSerializer } from "./whiteboardApiEditorSerializer.js";
import { WhiteboardCanvasEditorInput } from "./whiteboardCanvasEditorInput.js";
import { WhiteboardCanvasEditorPane } from "./whiteboardCanvasPart.js";
import { isWhiteboardReadonlySource } from "../../../common/whiteboardReadonlySource.js";

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	WhiteboardCanvasEditorInput.ID,
	WhiteboardApiEditorSerializer,
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(WhiteboardCanvasEditorPane, WhiteboardCanvasEditorPane.ID, "Whiteboard"),
	[new SyncDescriptor(WhiteboardCanvasEditorInput)],
);

class WhiteboardCanvasEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = "workbench.contrib.devfast.whiteboardCanvasEditor";

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
		@IWhiteboardDesktopConnectionService
		private readonly desktopConnection: IWhiteboardDesktopConnectionService,
		@IWhiteboardApiCatalogService private readonly apiCatalog: IWhiteboardApiCatalogService,
		@IWhiteboardCanvasEditorTabsService
		private readonly tabsService: IWhiteboardCanvasEditorTabsService,
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const editor = this.editorService.activeEditor;
			const resource = EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
			if (editor && resource && isWhiteboardReadonlySource(resource)) this.tabsService.registerWhiteboardEditor(resource.authority, editor);
		}));
		this._register(
			this.editorService.onDidCloseEditor(({ editor }) => {
				if (!(editor instanceof WhiteboardCanvasEditorInput)) return;
				if (editor.target.kind !== "api") {
					void this.tabsService.openHome(true);
				}
			}),
		);
		this._register(
			apiCatalog.onDidCloseWhiteboard((uuid) => {
				void this.tabsService.closeWhiteboard(uuid);
			}),
		);
		void this.initialize();
	}

	private async initialize(): Promise<void> {
		await this.editorGroupsService.whenRestored;
		// Restored pinned source editors belong to the same review as their URI.
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				const resource = EditorResourceAccessor.getCanonicalUri(editor, {
					supportSideBySide: SideBySideEditor.PRIMARY,
				});
				if (resource && isWhiteboardReadonlySource(resource)) this.tabsService.registerWhiteboardEditor(resource.authority, editor);
			}
		}
		this.closeRestoredApiTabsMissingFromCatalog();
		await this.tabsService.openHome(!this.editorService.activeEditor);
		await this.desktopConnection.initialize();
		await this.apiCatalog.initialize();
	}

	/** Restored API tabs may belong to reviews deleted or dismissed while the app was closed. */
	private closeRestoredApiTabsMissingFromCatalog(): void {
		const restored = new Set(
			this.editorGroupsService.groups.flatMap((group) =>
				group.editors.flatMap((editor) =>
					editor instanceof WhiteboardCanvasEditorInput &&
					(editor.target.kind === "api" || editor.target.kind === "api-source")
						? [editor.target.sessionId]
						: [],
				),
			),
		);
		if (restored.size === 0) return;
		const reconcile = async () => {
			// The managed tutorial is intentionally absent from the Home catalog.
			const tutorial = await this.desktopConnection.getTutorialStatus().catch(() => undefined);
			for (const sessionId of restored) {
				if (sessionId === tutorial?.sessionId) continue;
				const review = this.apiCatalog.reviews.find((review) => review.sessionId === sessionId);
				if (!review || review.dismissedAt) void this.tabsService.closeWhiteboard(sessionId);
			}
		};
		if (this.apiCatalog.loaded) void reconcile();
		else
			this._register(
				Event.once(this.apiCatalog.onDidChange)(() => {
					void reconcile();
				}),
			);
	}
}

registerWorkbenchContribution2(
	WhiteboardCanvasEditorContribution.ID,
	WhiteboardCanvasEditorContribution,
	WorkbenchPhase.AfterRestored,
);
