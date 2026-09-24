/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// The native workbench owns layout, navigation, file search and text search.
// Review's canvas, workspace adapters and Agents-window defaults stay in its
// own entry point; the editor/extension-host services are shared.
import './editor.common.main.js';
import './editor.desktop.main.js';
import { reviewConfigurationDefaults } from './common/reviewConfigurationDefaults.js';
import '../workbench/browser/workbench.zenMode.contribution.js';
import '../workbench/browser/actions/layoutActions.js';
import '../workbench/browser/parts/editor/editorParts.js';
import '../workbench/browser/parts/paneCompositePartService.js';
import '../workbench/browser/parts/banner/bannerPart.js';
import '../workbench/browser/parts/statusbar/statusbarPart.js';
import '../workbench/browser/parts/titlebar/menubar.contribution.js';
import '../workbench/services/title/electron-browser/titleService.js';
import '../workbench/services/workspaces/electron-browser/workspaceEditingService.js';
import '../workbench/contrib/search/browser/search.contribution.js';
import '../workbench/contrib/searchEditor/browser/searchEditor.contribution.js';
import '../workbench/services/notebook/common/notebookDocumentService.js';
import '../workbench/services/aiRelatedInformation/common/aiRelatedInformationService.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../platform/quickinput/common/quickAccess.js';
import { CommandsQuickAccessProvider, ShowAllCommandsAction } from '../workbench/contrib/quickaccess/browser/commandsQuickAccess.js';
import { ChatAgentService, IChatAgentService } from '../workbench/contrib/chat/common/participants/chatAgents.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { INotebookService } from '../workbench/contrib/notebook/common/notebookService.js';
import { NotebookService } from '../workbench/contrib/notebook/browser/services/notebookServiceImpl.js';
import { INotebookEditorService } from '../workbench/contrib/notebook/browser/services/notebookEditorService.js';
import { NotebookEditorWidgetService } from '../workbench/contrib/notebook/browser/services/notebookEditorServiceImpl.js';
import { INotebookEditorModelResolverService } from '../workbench/contrib/notebook/common/notebookEditorModelResolverService.js';
import { NotebookModelResolverServiceImpl } from '../workbench/contrib/notebook/common/notebookEditorModelResolverServiceImpl.js';
import { ISCMService } from '../workbench/contrib/scm/common/scm.js';
import { SCMService } from '../workbench/contrib/scm/common/scmService.js';
import { Registry } from '../platform/registry/common/platform.js';
import { Extensions, IConfigurationRegistry } from '../platform/configuration/common/configurationRegistry.js';
import { IStorageService, StorageScope, StorageTarget } from '../platform/storage/common/storage.js';
import { AccountsActivityActionViewItem } from '../workbench/browser/parts/globalCompositeBar.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../workbench/common/contributions.js';
import { IEditorResolverService } from '../workbench/services/editor/common/editorResolverService.js';
import { IConfigurationService } from '../platform/configuration/common/configuration.js';
import { Disposable } from '../base/common/lifecycle.js';
import { Extensions as ViewExtensions, IViewsRegistry, type IViewDescriptor, type ViewContainer } from '../workbench/common/views.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';
import { VIEW_ID as EXPLORER_FOLDERS_VIEW_ID } from '../workbench/contrib/files/common/files.js';
import './browser/reviewDecorationColors.js';
import { NavigatorDecorationsService, NavigatorDiffEditorResolverService, NavigatorEmptySourceContentProvider, reviewFilesBase, SOURCE_MODE_CONTEXT, type SourceMode } from './services/navigatorDiffEditorResolverService.js';
import { localize, localize2 } from '../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../platform/instantiation/common/instantiation.js';
import { Codicon } from '../base/common/codicons.js';
import type { ThemeIcon } from '../base/common/themables.js';
import type { ILocalizedString } from '../platform/action/common/action.js';
import { isCodeEditor, isDiffEditor } from '../editor/browser/editorBrowser.js';
import { IEditorService } from '../workbench/services/editor/common/editorService.js';
import { IDecorationsService } from '../workbench/services/decorations/common/decorations.js';

/** Set by the built-in review-files extension once its tree has listed the compared files. */
const REVIEW_FILES_ENABLED_CONTEXT = 'reviewFiles.enabled';

class NavigatorDefaults {
	constructor(@IStorageService storage: IStorageService) {
		// Use VS Code's own Hide Accounts preference; users can show it again.
		const key = AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY;
		if (storage.get(key, StorageScope.PROFILE) === undefined) {
			storage.store(key, false, StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}

registerWorkbenchContribution2('review.navigator.defaults', NavigatorDefaults, WorkbenchPhase.BlockStartup);

/**
 * The review-files tree replaces the Folders view once it has listed the
 * compared files. Folders comes back if the tree cannot list them, so the
 * window always shows the head source. Folders also keeps the Explorer
 * populated while the window restores its sidebar.
 */
class NavigatorReviewFiles extends Disposable {
	constructor(
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		if (reviewFilesBase(configuration) === undefined) {
			return;
		}
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		let replaced: { folders: IViewDescriptor; container: ViewContainer } | undefined;
		const update = () => {
			const folders = views.getView(EXPLORER_FOLDERS_VIEW_ID);
			const container = views.getViewContainer(EXPLORER_FOLDERS_VIEW_ID);
			if (contextKeys.getContextKeyValue<boolean>(REVIEW_FILES_ENABLED_CONTEXT) === true) {
				if (folders && container) {
					replaced = { folders, container };
					views.deregisterViews([folders], container);
				}
			} else if (replaced && !folders) {
				const { folders: restored, container: restoredContainer } = replaced;
				replaced = undefined;
				views.registerViews([restored], restoredContainer);
			}
		};
		this._register(views.onViewsRegistered(update));
		this._register(contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(new Set([REVIEW_FILES_ENABLED_CONTEXT]))) {
				update();
			}
		}));
	}
}

const SOURCE_MODE_MENU = new MenuId('ReviewSourceMode');
const sourceModes = [
	{ mode: 'diff', icon: Codicon.diff, title: localize2('review.sourceMode.diff', "Show Diff") },
	{ mode: 'head', icon: Codicon.file, title: localize2('review.sourceMode.head', "Show Head") },
	{ mode: 'base', icon: Codicon.history, title: localize2('review.sourceMode.base', "Show Base") },
] satisfies { mode: SourceMode; icon: ThemeIcon; title: ILocalizedString }[];
// The source window names a base only when it has one to compare with.
const hasBase = ContextKeyExpr.has('config.reviewFiles.base');

for (const [order, { mode, icon, title }] of sourceModes.entries()) {
	// The title bar button shows the current mode.
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		submenu: SOURCE_MODE_MENU,
		title: localize('review.sourceMode', "Show Diff, Head or Base"),
		icon,
		group: 'navigation',
		order: -1,
		when: ContextKeyExpr.and(hasBase, ContextKeyExpr.equals(SOURCE_MODE_CONTEXT, mode)),
	});
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `reviewFiles.show.${mode}`,
				title,
				category: localize2('review.sourceMode.category', "Review Files"),
				f1: true,
				precondition: hasBase,
				toggled: ContextKeyExpr.equals(SOURCE_MODE_CONTEXT, mode),
				menu: { id: SOURCE_MODE_MENU, order },
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const resolver = accessor.get(IEditorResolverService);
			const editors = accessor.get(IEditorService);
			if (!(resolver instanceof NavigatorDiffEditorResolverService)) {
				return;
			}
			resolver.setMode(mode);

			// Reopen the active file in the new mode, at the same line.
			const pane = editors.activeEditorPane;
			const control = editors.activeTextEditorControl;
			const code = isDiffEditor(control) ? control.getModifiedEditor() : isCodeEditor(control) ? control : undefined;
			const resource = code?.getModel()?.uri;
			if (!pane || !resource) {
				return;
			}
			const position = code.getPosition();
			const source = resolver.sourceOf(resource);
			const selection = position && source === resource ? { startLineNumber: position.lineNumber, startColumn: position.column } : undefined;
			await editors.replaceEditors([{ editor: pane.input, replacement: { resource: source, options: { selection, pinned: true } } }], pane.group);
		}
	});
}

registerWorkbenchContribution2('review.navigator.reviewFiles', NavigatorReviewFiles, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2('review.navigator.emptySource', NavigatorEmptySourceContentProvider, WorkbenchPhase.BlockStartup);
registerSingleton(IEditorResolverService, NavigatorDiffEditorResolverService, InstantiationType.Delayed);
registerSingleton(IDecorationsService, NavigatorDecorationsService, InstantiationType.Delayed);

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: CommandsQuickAccessProvider,
	prefix: CommandsQuickAccessProvider.PREFIX,
	contextKey: 'inCommandsPicker',
	helpEntries: [{ description: 'Show and Run Commands', commandId: ShowAllCommandsAction.ID }],
});
registerAction2(ShowAllCommandsAction);
registerSingleton(IChatAgentService, ChatAgentService, InstantiationType.Delayed);

registerSingleton(INotebookService, NotebookService, InstantiationType.Delayed);
registerSingleton(INotebookEditorService, NotebookEditorWidgetService, InstantiationType.Delayed);
registerSingleton(INotebookEditorModelResolverService, NotebookModelResolverServiceImpl, InstantiationType.Delayed);
registerSingleton(ISCMService, SCMService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'security.workspace.trust.enabled': false,
		'workbench.startupEditor': 'none',
		// Every source file opens as a whole-file inline diff against the base.
		'diffEditor.renderSideBySide': false,
		'diffEditor.hideUnchangedRegions.enabled': false,
		// A base file lies outside the workspace folder, so its full path would
		// fill the breadcrumbs; the Files tree already shows where a file sits.
		'breadcrumbs.filePath': 'last',
		'window.autoDetectColorScheme': reviewConfigurationDefaults['window.autoDetectColorScheme'],
		'workbench.colorTheme': reviewConfigurationDefaults['workbench.colorTheme'],
		'workbench.preferredDarkColorTheme': reviewConfigurationDefaults['workbench.preferredDarkColorTheme'],
		'workbench.preferredLightColorTheme': reviewConfigurationDefaults['workbench.preferredLightColorTheme'],
	},
}]);

export { main } from '../workbench/electron-browser/desktop.main.js';
