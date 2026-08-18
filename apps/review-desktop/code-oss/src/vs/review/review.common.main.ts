/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Review's curated workbench manifest. Keep this list explicit: importing the
// stock or Sessions manifests re-registers the chrome and product surfaces that
// Review intentionally does not ship.

import "../editor/editor.all.js";
import { Event } from "../base/common/event.js";
import { Disposable, type IDisposable } from "../base/common/lifecycle.js";
import type { URI } from "../base/common/uri.js";
import { getColorRegistry } from "../platform/theme/common/colorUtils.js";
import { agentsPanelBackground } from "../workbench/common/agentTheme.js";
import { PANEL_BACKGROUND } from "../workbench/common/theme.js";

getColorRegistry().updateDefaultColor(PANEL_BACKGROUND, agentsPanelBackground);

// Core editor/workbench API.
import "./reviewExtensionHost.contribution.js";
import "../workbench/browser/workbench.contribution.js";
import "../workbench/browser/actions/textInputActions.js";
import "../workbench/browser/actions/listCommands.js";
import "../workbench/browser/actions/navigationActions.js";
import "../workbench/browser/actions/windowActions.js";
import "../workbench/browser/actions/workspaceActions.js";
import "../workbench/browser/actions/workspaceCommands.js";
import "../workbench/browser/actions/quickAccessActions.js";
import "../workbench/browser/actions/widgetNavigationCommands.js";
import "../workbench/services/actions/common/menusExtensionPoint.js";
import "../workbench/api/common/configurationExtensionPoint.js";
import "../workbench/api/browser/viewsExtensionPoint.js";
import "../workbench/browser/parts/editor/editor.contribution.js";
import "../workbench/browser/parts/editor/diffEditor.workbench.contribution.js";
// Core services required by editors, language features, webviews, and files.
import "../platform/actions/common/actions.contribution.js";
import "../platform/undoRedo/common/undoRedoService.js";
import "../workbench/services/workspaces/common/editSessionIdentityService.js";
import "../workbench/services/workspaces/common/canonicalUriService.js";
import "../workbench/services/extensions/browser/extensionUrlHandler.js";
import "../workbench/services/keybinding/common/keybindingEditing.js";
import "../workbench/services/decorations/browser/decorationsService.js";
import "../workbench/services/dialogs/common/dialogService.js";
import "../workbench/services/progress/browser/progressService.js";
import "../workbench/services/editor/browser/codeEditorService.js";
import "../workbench/services/preferences/browser/preferencesService.js";
import "../workbench/services/configuration/common/jsonEditingService.js";
import "../workbench/services/textmodelResolver/common/textModelResolverService.js";
import "../workbench/services/editor/browser/editorService.js";
import "../workbench/services/editor/browser/editorResolverService.js";
import "../workbench/services/history/browser/historyService.js";
import "../workbench/services/activity/browser/activityService.js";
import "../workbench/services/keybinding/browser/keybindingService.js";
import "../workbench/services/untitled/common/untitledTextEditorService.js";
import "../workbench/services/textresourceProperties/common/textResourcePropertiesService.js";
import "../workbench/services/textfile/common/textEditorService.js";
import "../workbench/services/language/common/languageService.js";
import "../workbench/services/model/common/modelService.js";
import "../workbench/services/commands/common/commandService.js";
import "../workbench/services/themes/browser/workbenchThemeService.js";
import "../workbench/services/label/common/labelService.js";
import "../workbench/services/extensions/common/extensionManifestPropertiesService.js";
import "../workbench/services/extensionManagement/common/extensionGalleryService.js";
import "../workbench/services/extensionManagement/browser/extensionEnablementService.js";
import "../workbench/services/extensionManagement/browser/builtinExtensionsScannerService.js";
import "../workbench/services/extensionRecommendations/common/extensionIgnoredRecommendationsService.js";
import "../workbench/services/extensionRecommendations/common/workspaceExtensionsConfig.js";
import "../workbench/services/extensionManagement/common/extensionFeaturesManagemetService.js";
import "../workbench/services/userDataSync/common/userDataSyncUtil.js";
import "../workbench/services/userDataProfile/browser/userDataProfileImportExportService.js";
import "../workbench/services/userDataProfile/browser/userDataProfileManagement.js";
import "../workbench/services/userDataProfile/common/remoteUserDataProfiles.js";
import "../workbench/services/remote/common/remoteExtensionsScanner.js";
import "../workbench/services/notification/common/notificationService.js";
import "../workbench/services/workingCopy/common/workingCopyService.js";
import "../workbench/services/workingCopy/common/workingCopyFileService.js";
import "../workbench/services/workingCopy/common/workingCopyEditorService.js";
import "../workbench/services/filesConfiguration/common/filesConfigurationService.js";
import "../workbench/services/views/browser/viewDescriptorService.js";
import "../workbench/services/views/browser/viewsService.js";
import "../workbench/services/quickinput/browser/quickInputService.js";
import "../workbench/services/userDataSync/browser/userDataSyncWorkbenchService.js";
import "../workbench/services/authentication/browser/authenticationService.js";
import "../workbench/services/authentication/browser/authenticationExtensionsService.js";
import "../workbench/services/authentication/browser/authenticationUsageService.js";
import "../workbench/services/authentication/browser/authenticationAccessService.js";
import "../workbench/services/inlineCompletions/common/inlineCompletionsUnification.js";
import "../workbench/contrib/output/browser/output.contribution.js";
import "../platform/hover/browser/hoverService.js";
import "../platform/userInteraction/browser/userInteractionServiceImpl.js";
import "../workbench/services/languageDetection/browser/languageDetectionWorkerServiceImpl.js";
import "../editor/common/services/languageFeaturesService.js";
import "../editor/common/services/semanticTokensStylingService.js";
import "../editor/common/services/treeViewsDndService.js";
import "../workbench/services/textMate/browser/textMateTokenizationFeature.contribution.js";
import "../workbench/services/treeSitter/browser/treeSitter.contribution.js";
import "../workbench/services/userActivity/common/userActivityService.js";
import "../workbench/services/userActivity/browser/userActivityBrowser.js";
import "../workbench/services/userAttention/browser/userAttentionBrowser.js";
import "../workbench/services/editor/browser/editorPaneService.js";
import "../workbench/services/editor/common/customEditorLabelService.js";
import "../workbench/services/dataChannel/browser/dataChannelService.js";
import "../workbench/services/log/common/defaultLogLevels.js";
import { OpenerService } from "../editor/browser/services/openerService.js";
import { IMarkerDecorationsService } from "../editor/common/services/markerDecorations.js";
import { MarkerDecorationsService } from "../editor/common/services/markerDecorationsService.js";
import { ITextResourceConfigurationService } from "../editor/common/services/textResourceConfiguration.js";
import { TextResourceConfigurationService } from "../editor/common/services/textResourceConfigurationService.js";
import { ContextKeyService } from "../platform/contextkey/browser/contextKeyService.js";
import { IContextKeyService } from "../platform/contextkey/common/contextkey.js";
import { IContextViewService } from "../platform/contextview/browser/contextView.js";
import { ContextViewService } from "../platform/contextview/browser/contextViewService.js";
import { IDownloadService } from "../platform/download/common/download.js";
import { DownloadService } from "../platform/download/common/downloadService.js";
import { AllowedExtensionsService } from "../platform/extensionManagement/common/allowedExtensionsService.js";
import { GlobalExtensionEnablementService } from "../platform/extensionManagement/common/extensionEnablementService.js";
import {
  IAllowedExtensionsService,
  IGlobalExtensionEnablementService,
} from "../platform/extensionManagement/common/extensionManagement.js";
import {
  ExtensionStorageService,
  IExtensionStorageService,
} from "../platform/extensionManagement/common/extensionStorage.js";
import {
  InstantiationType,
  registerSingleton,
} from "../platform/instantiation/common/extensions.js";
import {
  IListService,
  ListService,
} from "../platform/list/browser/listService.js";
import { IMarkerService } from "../platform/markers/common/markers.js";
import { MarkerService } from "../platform/markers/common/markerService.js";
import { IOpenerService } from "../platform/opener/common/opener.js";
import {
  IgnoredExtensionsManagementService,
  IIgnoredExtensionsManagementService,
} from "../platform/userDataSync/common/ignoredExtensions.js";
import { IUserDataSyncLogService } from "../platform/userDataSync/common/userDataSync.js";
import { UserDataSyncLogService } from "../platform/userDataSync/common/userDataSyncLog.js";
import { IWebWorkerService } from "../platform/webWorker/browser/webWorkerService.js";
import { WebWorkerService } from "../platform/webWorker/browser/webWorkerServiceImpl.js";
import {
  ChatContextPickService,
  IChatContextPickService,
} from "../workbench/contrib/chat/browser/attachments/chatContextPickService.js";
import {
  type IChatWidget,
  IChatWidgetService,
} from "../workbench/contrib/chat/browser/chat.js";
import type { IChatEditorOptions } from "../workbench/contrib/chat/browser/widgetHosts/editor/chatEditor.js";
import type { ChatAgentLocation } from "../workbench/contrib/chat/common/constants.js";
import type { PreferredGroup } from "../workbench/services/editor/common/editorService.js";

class ReviewChatWidgetService implements IChatWidgetService {
  declare readonly _serviceBrand: undefined;

  readonly lastFocusedWidget = undefined;
  readonly onDidAddWidget = Event.None;
  readonly onDidBackgroundSession = Event.None;
  readonly onDidChangeFocusedWidget = Event.None;
  readonly onDidChangeFocusedSession = Event.None;

  reveal(_widget: IChatWidget, _preserveFocus?: boolean): Promise<boolean> {
    return Promise.resolve(false);
  }

  revealWidget(_preserveFocus?: boolean): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  getAllWidgets(): readonly IChatWidget[] {
    return [];
  }

  getWidgetByInputUri(_uri: URI): undefined {
    return undefined;
  }

  openSession(_sessionResource: URI): Promise<undefined>;
  openSession(
    _sessionResource: URI,
    _target?: PreferredGroup,
    _options?: IChatEditorOptions,
  ): Promise<undefined>;
  openSession(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  getWidgetBySessionResource(_sessionResource: URI): undefined {
    return undefined;
  }

  getWidgetsByLocations(_location: ChatAgentLocation): readonly IChatWidget[] {
    return [];
  }

  register(_newWidget: IChatWidget): IDisposable {
    return Disposable.None;
  }
}

registerSingleton(
  IUserDataSyncLogService,
  UserDataSyncLogService,
  InstantiationType.Delayed,
);
registerSingleton(
  IAllowedExtensionsService,
  AllowedExtensionsService,
  InstantiationType.Delayed,
);
registerSingleton(
  IIgnoredExtensionsManagementService,
  IgnoredExtensionsManagementService,
  InstantiationType.Delayed,
);
registerSingleton(
  IGlobalExtensionEnablementService,
  GlobalExtensionEnablementService,
  InstantiationType.Delayed,
);
registerSingleton(
  IExtensionStorageService,
  ExtensionStorageService,
  InstantiationType.Delayed,
);
registerSingleton(
  IContextViewService,
  ContextViewService,
  InstantiationType.Delayed,
);
registerSingleton(IListService, ListService, InstantiationType.Delayed);
registerSingleton(
  IMarkerDecorationsService,
  MarkerDecorationsService,
  InstantiationType.Delayed,
);
registerSingleton(IMarkerService, MarkerService, InstantiationType.Delayed);
registerSingleton(
  IContextKeyService,
  ContextKeyService,
  InstantiationType.Delayed,
);
registerSingleton(
  IChatContextPickService,
  ChatContextPickService,
  InstantiationType.Delayed,
);
registerSingleton(
  IChatWidgetService,
  ReviewChatWidgetService,
  InstantiationType.Delayed,
);
registerSingleton(
  ITextResourceConfigurationService,
  TextResourceConfigurationService,
  InstantiationType.Delayed,
);
registerSingleton(IDownloadService, DownloadService, InstantiationType.Delayed);
registerSingleton(IOpenerService, OpenerService, InstantiationType.Delayed);
registerSingleton(
  IWebWorkerService,
  WebWorkerService,
  InstantiationType.Delayed,
);

// Curated contributions: editor/files/theme/webview/outline/logs only.
import "../workbench/contrib/logs/common/logs.contribution.js";
import "./contrib/quickaccess/reviewQuickAccess.contribution.js";
import "./browser/reviewTheme.contribution.js";
import "./contrib/extensions/reviewCuratedExtensions.contribution.js";
import "./contrib/install/reviewCliInstall.contribution.js";
import "./contrib/telemetry/reviewLspTelemetry.contribution.js";
import "./contrib/telemetry/reviewTelemetry.contribution.js";
import "./contrib/settings/reviewSettings.contribution.js";
import "./contrib/explorer/reviewFileTree.contribution.js";
import "./contrib/workspace/reviewWorkspaceFolder.contribution.js";
import "./browser/parts/canvas/reviewCanvasEditor.contribution.js";
import "./browser/parts/canvas/reviewFind.contribution.js";
import "../workbench/contrib/comments/browser/comments.contribution.js";
import "./contrib/comments/reviewComments.contribution.js";
import "../workbench/contrib/files/browser/fileActions.contribution.js";
import "../workbench/contrib/files/browser/files.contribution.js";
import "../workbench/contrib/bulkEdit/browser/bulkEditService.js";
import "../workbench/contrib/terminal/browser/terminal.contribution.js";
import "../workbench/contrib/terminal/common/environmentVariable.contribution.js";
import "../workbench/contrib/terminal/common/terminalExtensionPoints.contribution.js";
// editor.all instantiates RenameSymbolProcessor; keep its service-only peer.
import "../workbench/contrib/inlineCompletions/browser/renameSymbolTrackerService.js";
import "../workbench/contrib/search/browser/searchQuickAccess.contribution.js";
import "../workbench/contrib/sash/browser/sash.contribution.js";
import { IDebugService } from "../workbench/contrib/debug/common/debug.js";
import { IDebugVisualizerService } from "../workbench/contrib/debug/common/debugVisualizers.js";
import {
  NullDebugService,
  NullDebugVisualizerService,
} from "../workbench/contrib/debug/common/nullDebugService.js";
registerSingleton(IDebugService, NullDebugService, InstantiationType.Delayed);
registerSingleton(
  IDebugVisualizerService,
  NullDebugVisualizerService,
  InstantiationType.Delayed,
);
import "../workbench/contrib/commands/common/commands.contribution.js";
import "../workbench/contrib/webview/browser/webview.contribution.js";
import "../workbench/contrib/webviewPanel/browser/webviewPanel.contribution.js";
import "../workbench/contrib/keybindings/browser/keybindings.contribution.js";
import "../workbench/contrib/snippets/browser/snippets.service.contribution.js";
import "../workbench/contrib/format/browser/format.contribution.js";
import "../workbench/contrib/folding/browser/folding.contribution.js";
import "../workbench/contrib/themes/browser/themes.contribution.js";
import "../workbench/services/outline/browser/outlineService.js";
import "../workbench/contrib/codeEditor/browser/outline/documentSymbolsOutline.js";
import "../workbench/contrib/codeEditor/browser/workbenchReferenceSearch.js";
import "../workbench/contrib/codeActions/browser/codeActions.contribution.js";
import "../workbench/contrib/workspace/browser/workspace.contribution.js";
import "../workbench/contrib/list/browser/list.contribution.js";
import "../workbench/contrib/accessibilitySignals/browser/accessibilitySignal.contribution.js";
import "../workbench/contrib/accessibility/browser/accessibility.contribution.js";
import "../workbench/contrib/speech/browser/speech.contribution.js";
import "../workbench/contrib/opener/browser/opener.contribution.js";
// Sessions supplies the native fixed-grid shell; Review replaces its session
// model, setup flow, and content part and deliberately imports no Agents UI.
import "../workbench/browser/parts/editor/editorParts.js";
import "./browser/reviewPaneCompositePartService.js";
import "./common/reviewConfiguration.js";
import "./common/reviewMapColors.js";
import "./services/reviewWorkbenchServices.js";
import { IReviewCanvasPartsService, ReviewCanvasParts } from "./browser/parts/canvas/reviewCanvasPart.js";
import {
  IReviewExplorerPartsService,
  ReviewExplorerParts,
} from "./browser/parts/explorer/reviewExplorerPart.js";
import {
  IReviewVerbsService,
  ReviewVerbsService,
} from "./contrib/verbs/reviewVerbs.js";
import {
  IReviewCodeResourceService,
  ReviewCodeResourceService,
} from "./services/reviewCodeResourceService.js";
import {
  IReviewSessionService,
  ReviewSessionService,
} from "./services/reviewSessionService.js";
import {
  IReviewTelemetryService,
  ReviewTelemetryService,
} from "./services/reviewTelemetryService.js";
import {
  IReviewSessionModelService,
  ReviewSessionModelService,
} from "./services/reviewSessionModelService.js";
import {
  IReviewCanvasEditorTabsService,
  ReviewCanvasEditorTabsService,
} from "./services/reviewCanvasEditorTabsService.js";
import {
  IReviewDiffTabsService,
  ReviewDiffTabsService,
} from "./services/reviewDiffTabs.js";

registerSingleton(
  IReviewSessionService,
  ReviewSessionService,
  InstantiationType.Eager,
);
registerSingleton(
  IReviewTelemetryService,
  ReviewTelemetryService,
  InstantiationType.Delayed,
);
registerSingleton(
  IReviewSessionModelService,
  ReviewSessionModelService,
  InstantiationType.Delayed,
);
registerSingleton(
  IReviewCanvasEditorTabsService,
  ReviewCanvasEditorTabsService,
  InstantiationType.Delayed,
);
registerSingleton(
  IReviewDiffTabsService,
  ReviewDiffTabsService,
  InstantiationType.Delayed,
);
registerSingleton(
  IReviewCodeResourceService,
  ReviewCodeResourceService,
  InstantiationType.Delayed,
);
registerSingleton(
  IReviewVerbsService,
  ReviewVerbsService,
  InstantiationType.Delayed,
);
registerSingleton(
	IReviewCanvasPartsService,
  ReviewCanvasParts,
  InstantiationType.Eager,
);
registerSingleton(
  IReviewExplorerPartsService,
  ReviewExplorerParts,
  InstantiationType.Eager,
);
