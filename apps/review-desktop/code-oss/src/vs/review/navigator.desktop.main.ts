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
import { registerAction2 } from '../platform/actions/common/actions.js';
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
		'window.autoDetectColorScheme': reviewConfigurationDefaults['window.autoDetectColorScheme'],
		'workbench.colorTheme': reviewConfigurationDefaults['workbench.colorTheme'],
		'workbench.preferredDarkColorTheme': reviewConfigurationDefaults['workbench.preferredDarkColorTheme'],
		'workbench.preferredLightColorTheme': reviewConfigurationDefaults['workbench.preferredLightColorTheme'],
	},
}]);

export { main } from '../workbench/electron-browser/desktop.main.js';
