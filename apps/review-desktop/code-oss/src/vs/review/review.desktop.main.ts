/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Desktop-only service manifest. Product contributions such as chat, SCM,
// terminal, tasks, remote, surveys, profiles, and settings editors are
// intentionally absent.
//
// Updates are the exception: the update service is wired so Review can surface
// its own two toasts (see contrib/update). The stock update contribution stays
// out — its title bar entry requires the chat service, which Review omits.
import './review.common.main.js';
import '../workbench/contrib/terminal/electron-browser/terminal.contribution.js';
import './electron-browser/review.main.js';
import '../workbench/electron-browser/desktop.contribution.js';
import '../workbench/electron-browser/parts/dialogs/dialog.contribution.js';

import '../workbench/services/textfile/electron-browser/nativeTextFileService.js';
import '../workbench/services/dialogs/electron-browser/fileDialogService.js';
import '../workbench/services/workspaces/electron-browser/workspacesService.js';
import '../workbench/services/menubar/electron-browser/menubarService.js';
import '../workbench/services/update/electron-browser/updateService.js';
import '../workbench/services/url/electron-browser/urlService.js';
import '../workbench/services/lifecycle/electron-browser/lifecycleService.js';
import '../workbench/services/host/electron-browser/nativeHostService.js';
import '../platform/meteredConnection/electron-browser/meteredConnectionService.js';
import '../workbench/services/request/electron-browser/requestService.js';
import '../workbench/services/clipboard/electron-browser/clipboardService.js';
import '../workbench/services/contextmenu/electron-browser/contextmenuService.js';
import '../workbench/services/configurationResolver/electron-browser/configurationResolverService.js';
import '../workbench/services/accessibility/electron-browser/accessibilityService.js';
import '../workbench/services/keybinding/electron-browser/nativeKeyboardLayout.js';
import '../workbench/services/path/electron-browser/pathService.js';
import '../workbench/services/themes/electron-browser/nativeHostColorSchemeService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionManagementService.js';
import '../workbench/services/encryption/electron-browser/encryptionService.js';
import '../workbench/services/imageResize/electron-browser/imageResizeService.js';
import '../workbench/services/secrets/electron-browser/secretStorageService.js';
import '../workbench/services/localization/electron-browser/languagePackService.js';
import '../workbench/services/telemetry/electron-browser/telemetryService.js';
import '../workbench/services/extensions/electron-browser/extensionHostStarter.js';
import '../platform/extensionResourceLoader/common/extensionResourceLoaderService.js';
import '../workbench/services/localization/electron-browser/localeService.js';
import '../workbench/services/extensions/electron-browser/extensionsScannerService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionManagementServerService.js';
import '../workbench/services/extensionManagement/electron-browser/extensionGalleryManifestService.js';
import '../workbench/services/userDataSync/electron-browser/userDataSyncService.js';
import '../workbench/services/userDataSync/browser/userDataSyncEnablementService.js';
import '../workbench/services/timer/electron-browser/timerService.js';
import '../workbench/services/environment/electron-browser/shellEnvironmentService.js';
import '../workbench/services/integrity/electron-browser/integrityService.js';
import '../workbench/services/workingCopy/electron-browser/workingCopyBackupService.js';
import '../workbench/services/checksum/electron-browser/checksumService.js';
import '../workbench/services/files/electron-browser/elevatedFileService.js';
import '../workbench/services/search/electron-browser/searchService.js';
import '../workbench/services/workingCopy/electron-browser/workingCopyHistoryService.js';
import '../workbench/services/extensions/electron-browser/nativeExtensionService.js';
import '../platform/userDataProfile/electron-browser/userDataProfileStorageService.js';
import '../workbench/services/auxiliaryWindow/electron-browser/auxiliaryWindowService.js';
import '../platform/extensionManagement/electron-browser/extensionsProfileScannerService.js';
import '../platform/sandbox/electron-browser/sandboxHelperService.js';
import '../workbench/services/process/electron-browser/processService.js';
import '../platform/remote/electron-browser/sharedProcessTunnelService.js';
import '../workbench/services/tunnel/electron-browser/tunnelService.js';
import '../workbench/contrib/debug/electron-browser/extensionHostDebugService.js';
import '../platform/diagnostics/electron-browser/diagnosticsService.js';

import { registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IUserDataInitializationService, UserDataInitializationService } from '../workbench/services/userData/browser/userDataInit.js';
import { SyncDescriptor } from '../platform/instantiation/common/descriptors.js';
registerSingleton(IUserDataInitializationService, new SyncDescriptor(UserDataInitializationService, [[]], true));

import '../workbench/contrib/logs/electron-browser/logs.contribution.js';
import '../workbench/contrib/files/electron-browser/fileActions.contribution.js';
import '../workbench/contrib/codeEditor/electron-browser/codeEditor.contribution.js';
import '../workbench/services/themes/electron-browser/themes.contribution.js';
import '../workbench/contrib/webview/electron-browser/webview.contribution.js';
import '../workbench/contrib/splash/electron-browser/splash.contribution.js';
import './contrib/update/reviewUpdate.contribution.js';

export { main } from './electron-browser/review.main.js';
