/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../editor/browser/editorBrowser.js';
import { MouseTargetType } from '../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { ContentHoverController } from '../../../editor/contrib/hover/browser/contentHoverController.js';
import { ClickLinkGesture } from '../../../editor/contrib/gotoSymbol/browser/link/clickLinkGesture.js';
import { ILanguageFeaturesService } from '../../../editor/common/services/languageFeatures.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { ModelDecorationInjectedTextOptions } from '../../../editor/common/model/textModel.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	type IWorkbenchContribution,
	type IWorkbenchContributionsRegistry,
} from '../../../workbench/common/contributions.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { LifecyclePhase } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { ReviewInlineEditorService } from '../../services/reviewInlineEditorService.js';
import { IReviewTelemetryService } from '../../services/reviewTelemetryService.js';

const HOVER_DWELL_MS = 1_000;
const HOVER_VISIBILITY_POLL_MS = 100;
const LS_ACTIVATION_WAIT_MS = 10_000;

const LANGUAGE_MAP: Record<string, string> = {
	typescript: 'typescript',
	typescriptreact: 'typescript',
	javascript: 'javascript',
	javascriptreact: 'javascript',
	python: 'python',
	go: 'go',
	rust: 'rust',
	swift: 'swift',
	csharp: 'csharp',
	json: 'json',
	jsonc: 'json',
	css: 'css',
	scss: 'css',
	less: 'css',
	html: 'html',
	markdown: 'markdown',
	yaml: 'yaml',
	toml: 'toml',
	shellscript: 'shell',
	sql: 'sql',
};

function toLspLanguage(languageId: string): string {
	return Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, languageId)
		? LANGUAGE_MAP[languageId]
		: 'other';
}

const LSP_COMMANDS: Record<string, string> = {
	'editor.action.revealDefinition': 'goto_definition',
	'editor.action.revealDefinitionAside': 'goto_definition',
	'editor.action.goToDeclaration': 'goto_definition',
	'editor.action.revealDeclaration': 'goto_definition',
	'editor.action.peekDefinition': 'peek_definition',
	'editor.action.peekDeclaration': 'peek_definition',
	'editor.action.previewDeclaration': 'peek_definition',
	'editor.action.goToTypeDefinition': 'goto_type_definition',
	'editor.action.peekTypeDefinition': 'goto_type_definition',
	'editor.action.goToImplementation': 'goto_implementation',
	'editor.action.peekImplementation': 'goto_implementation',
	'editor.action.goToReferences': 'references',
	'editor.action.referenceSearch.trigger': 'references',
	'editor.action.findReferences': 'references',
	'editor.action.rename': 'rename',
	'editor.action.formatDocument': 'format',
	'editor.action.formatSelection': 'format',
	'editor.action.quickFix': 'code_action',
	'editor.action.showHover': 'hover',
	'editor.action.showDefinitionPreviewHover': 'hover',
	'workbench.action.gotoSymbol': 'symbol_search',
};

const LS_EXTENSIONS: Record<string, string> = {
	python: 'astral-sh.ty',
	go: 'golang.go',
	rust: 'rust-lang.rust-analyzer',
	swift: 'swiftlang.swift-vscode',
	csharp: 'muhammad-sammy.csharp',
};

class ReviewLspTelemetryContribution extends Disposable implements IWorkbenchContribution {
	private readonly editorStores = new Map<ICodeEditor, DisposableStore>();
	private readonly lastCommandHover = new WeakMap<ICodeEditor, number>();
	private readonly scheduledLsGroups = new Set<string>();

	constructor(
		@ICommandService commandService: ICommandService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IModelService modelService: IModelService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IReviewTelemetryService private readonly telemetryService: IReviewTelemetryService,
	) {
		super();
		this._register(commandService.onDidExecuteCommand(event => {
			const feature = Object.prototype.hasOwnProperty.call(LSP_COMMANDS, event.commandId)
				? LSP_COMMANDS[event.commandId]
				: undefined;
			if (!feature) {
				return;
			}
			const editor = this.activeEditor();
			const model = editor?.getModel();
			if (!editor || !model) {
				return;
			}
			if (feature === 'hover') {
				this.lastCommandHover.set(editor, Date.now());
			}
			this.captureLspUsed(editor, model, feature, 'command');
		}));

		for (const editor of codeEditorService.listCodeEditors()) {
			this.trackEditor(editor);
		}
		this._register(codeEditorService.onCodeEditorAdd(editor => this.trackEditor(editor)));
		this._register(codeEditorService.onCodeEditorRemove(editor => this.untrackEditor(editor)));

		for (const model of modelService.getModels()) {
			this.scheduleLsHealth(model);
		}
		this._register(modelService.onModelAdded(model => this.scheduleLsHealth(model)));
		this._register(modelService.onModelLanguageChanged(({ model }) => this.scheduleLsHealth(model)));
	}

	private activeEditor(): ICodeEditor | null {
		return this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
	}

	private trackEditor(editor: ICodeEditor): void {
		if (this.editorStores.has(editor)) {
			return;
		}
		const store = new DisposableStore();
		this.editorStores.set(editor, store);
		this._register(store);

		const hoverController = ContentHoverController.get(editor);
		if (hoverController) {
			this.trackHover(editor, hoverController, store);
		}

		const clickLinkGesture = store.add(new ClickLinkGesture(editor));
		store.add(clickLinkGesture.onExecute(event => {
			const model = editor.getModel();
			const position = event.target.position;
			if (
				!model
				|| !position
				|| !event.isLeftClick
				|| !event.isNoneOrSingleMouseDown
				|| !event.hasTriggerModifier
				|| event.target.type !== MouseTargetType.CONTENT_TEXT
				|| event.target.detail.injectedText?.options instanceof ModelDecorationInjectedTextOptions
				|| !model.getWordAtPosition(position)
				|| !this.languageFeaturesService.definitionProvider.has(model)
			) {
				return;
			}
			this.captureLspUsed(editor, model, 'goto_definition', 'mouse');
		}));
	}

	private trackHover(editor: ICodeEditor, controller: ContentHoverController, store: DisposableStore): void {
		let captured = false;
		const dwell = store.add(new RunOnceScheduler(() => {
			if (!controller.isHoverVisible) {
				captured = false;
				return;
			}
			captured = true;
			if (Date.now() - (this.lastCommandHover.get(editor) ?? 0) >= HOVER_DWELL_MS) {
				const model = editor.getModel();
				if (model) {
					this.captureLspUsed(editor, model, 'hover', 'mouse');
				}
			}
			visibilityPoll.schedule(HOVER_VISIBILITY_POLL_MS);
		}, HOVER_DWELL_MS));
		const visibilityPoll = store.add(new RunOnceScheduler(() => {
			if (controller.isHoverVisible) {
				visibilityPoll.schedule(HOVER_VISIBILITY_POLL_MS);
				return;
			}
			captured = false;
		}, HOVER_VISIBILITY_POLL_MS));
		const resetIfHidden = () => {
			if (controller.isHoverVisible) {
				return;
			}
			dwell.cancel();
			visibilityPoll.cancel();
			captured = false;
		};

		store.add(controller.onHoverContentsChanged(() => {
			if (!controller.isHoverVisible) {
				resetIfHidden();
				return;
			}
			if (!captured) {
				dwell.schedule(HOVER_DWELL_MS);
			}
		}));
		store.add(editor.onMouseMove(resetIfHidden));
		store.add(editor.onMouseLeave(resetIfHidden));
		store.add(editor.onMouseDown(resetIfHidden));
		store.add(editor.onDidScrollChange(resetIfHidden));
		store.add(editor.onDidChangeModel(resetIfHidden));
	}

	private untrackEditor(editor: ICodeEditor): void {
		this.editorStores.get(editor)?.dispose();
		this.editorStores.delete(editor);
	}

	private captureLspUsed(editor: ICodeEditor, model: ITextModel, feature: string, via: string): void {
		this.telemetryService.capture('lsp_used', {
			feature,
			via,
			language: toLspLanguage(model.getLanguageId()),
			editor_kind: this.editorKind(editor),
		});
	}

	private editorKind(editor: ICodeEditor): string {
		if (ReviewInlineEditorService.owns(editor)) {
			return 'inline_peek';
		}
		for (const diffEditor of this.codeEditorService.listDiffEditors()) {
			if (diffEditor.getOriginalEditor() === editor || diffEditor.getModifiedEditor() === editor) {
				return 'diff';
			}
		}
		return 'files_tab';
	}

	private scheduleLsHealth(model: ITextModel): void {
		const group = toLspLanguage(model.getLanguageId());
		const extensionId = LS_EXTENSIONS[group];
		if (!extensionId || this.scheduledLsGroups.has(group)) {
			return;
		}
		this.scheduledLsGroups.add(group);
		const timer = new RunOnceScheduler(() => {
			const status = this.extensionService.getExtensionsStatus()[extensionId];
			this.telemetryService.capture('ls_activated', {
				group,
				ok: status?.activationTimes !== undefined && status.runningLocation !== null,
			});
		}, LS_ACTIVATION_WAIT_MS);
		this._register(timer);
		timer.schedule();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench,
).registerWorkbenchContribution(ReviewLspTelemetryContribution, LifecyclePhase.Eventually);
