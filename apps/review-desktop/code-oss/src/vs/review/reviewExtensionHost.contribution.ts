/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../workbench/common/contributions.js';
import { LanguageConfigurationFileHandler } from '../workbench/contrib/codeEditor/common/languageConfigurationExtensionPoint.js';
import { JSONValidationExtensionPoint } from '../workbench/api/common/jsonValidationExtensionPoint.js';
import { StatusBarItemsExtensionPoint } from '../workbench/api/browser/statusBarExtensionPoint.js';
import { CSSExtensionPoint } from '../workbench/services/themes/browser/cssExtensionPoint.js';
import { ColorExtensionPoint } from '../workbench/services/themes/common/colorExtensionPoint.js';
import { IconExtensionPoint } from '../workbench/services/themes/common/iconExtensionPoint.js';
import { TokenClassificationExtensionPoints } from '../workbench/services/themes/common/tokenClassificationExtensionPoint.js';

// Review exposes the generic editor/document/provider bridge. The stock Node
// extension host eagerly initializes a small set of additional API services;
// Review registers explicit unsupported peers for those APIs rather than
// pulling their terminal/task/authentication/chat product graphs into the app.
import './reviewExtensionHostUnsupportedApiPeers.js';
import '../workbench/api/browser/mainThreadLocalization.js';
import '../workbench/api/browser/mainThreadBulkEdits.js';
import '../workbench/api/browser/mainThreadClipboard.js';
import '../workbench/api/browser/mainThreadCommands.js';
import '../workbench/api/browser/mainThreadConfiguration.js';
import '../workbench/api/browser/mainThreadConsole.js';
import '../workbench/api/browser/mainThreadDebugService.js';
import '../workbench/api/browser/mainThreadDecorations.js';
import '../workbench/api/browser/mainThreadDiagnostics.js';
import '../workbench/api/browser/mainThreadDialogs.js';
import '../workbench/api/browser/mainThreadDocumentContentProviders.js';
import '../workbench/api/browser/mainThreadDocuments.js';
import '../workbench/api/browser/mainThreadDocumentsAndEditors.js';
import '../workbench/api/browser/mainThreadEditor.js';
import '../workbench/api/browser/mainThreadEditors.js';
import '../workbench/api/browser/mainThreadEditorTabs.js';
import '../workbench/api/browser/mainThreadErrors.js';
import '../workbench/api/browser/mainThreadExtensionService.js';
import '../workbench/api/browser/mainThreadFileSystem.js';
import '../workbench/api/browser/mainThreadFileSystemEventService.js';
import '../workbench/api/browser/mainThreadLanguageFeatures.js';
import '../workbench/api/browser/mainThreadLanguages.js';
import '../workbench/api/browser/mainThreadLogService.js';
import '../workbench/api/browser/mainThreadMessageService.js';
import '../workbench/api/browser/mainThreadOutputService.js';
import '../workbench/api/browser/mainThreadProgress.js';
import '../workbench/api/browser/mainThreadQuickOpen.js';
import '../workbench/api/browser/mainThreadRemoteConnectionData.js';
import '../workbench/api/browser/mainThreadSaveParticipant.js';
import '../workbench/api/browser/mainThreadSearch.js';
import '../workbench/api/browser/mainThreadStatusBar.js';
import '../workbench/api/browser/mainThreadStorage.js';
import '../workbench/api/browser/mainThreadTelemetry.js';
import '../workbench/api/browser/mainThreadTheming.js';
import '../workbench/api/browser/mainThreadTreeViews.js';
import '../workbench/api/browser/mainThreadDownloadService.js';
import '../workbench/api/browser/mainThreadWindow.js';
import '../workbench/api/browser/mainThreadWorkspace.js';
import '../workbench/api/browser/mainThreadLabelService.js';
import '../workbench/api/browser/mainThreadSecretState.js';

class ReviewExtensionPoints implements IWorkbenchContribution {
	static readonly ID = 'review.contrib.extensionPoints';

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		instantiationService.createInstance(JSONValidationExtensionPoint);
		instantiationService.createInstance(ColorExtensionPoint);
		instantiationService.createInstance(IconExtensionPoint);
		instantiationService.createInstance(TokenClassificationExtensionPoints);
		instantiationService.createInstance(LanguageConfigurationFileHandler);
		instantiationService.createInstance(StatusBarItemsExtensionPoint);
		instantiationService.createInstance(CSSExtensionPoint);
	}
}

registerWorkbenchContribution2(ReviewExtensionPoints.ID, ReviewExtensionPoints, WorkbenchPhase.BlockStartup);
