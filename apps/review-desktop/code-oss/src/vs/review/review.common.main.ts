/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./editor.common.main.js";
import { InstantiationType, registerSingleton } from "../platform/instantiation/common/extensions.js";
import { getColorRegistry } from "../platform/theme/common/colorUtils.js";
import { agentsPanelBackground } from "../workbench/common/agentTheme.js";
import { PANEL_BACKGROUND } from "../workbench/common/theme.js";
getColorRegistry().updateDefaultColor(PANEL_BACKGROUND, agentsPanelBackground);
import "./browser/parts/canvas/reviewCanvasEditor.contribution.js";
import "./browser/parts/canvas/reviewFind.contribution.js";
import "./browser/reviewCommunity.contribution.js";
import "./browser/reviewTheme.contribution.js";
import "./contrib/explorer/reviewFileTree.contribution.js";
import "./contrib/extensions/reviewCuratedExtensions.contribution.js";
import "./contrib/install/reviewCliInstall.contribution.js";
import "./contrib/quickaccess/reviewQuickAccess.contribution.js";
import "./contrib/settings/reviewSettings.contribution.js";
import "./contrib/telemetry/reviewLspTelemetry.contribution.js";
import "./contrib/telemetry/reviewTelemetry.contribution.js";
// Sessions supplies the native fixed-grid shell; Review replaces its session
// model, setup flow, and content part and deliberately imports no Agents UI.
import "../workbench/browser/parts/editor/editorParts.js";
import { IReviewCanvasPartsService, ReviewCanvasParts } from "./browser/parts/canvas/reviewCanvasPart.js";
import { IReviewExplorerPartsService, ReviewExplorerParts } from "./browser/parts/explorer/reviewExplorerPart.js";
import "./browser/reviewPaneCompositePartService.js";
import "./common/reviewConfiguration.js";
import { IReviewVerbsService, ReviewVerbsService } from "./contrib/verbs/reviewVerbs.js";
import { IReviewApiCatalogService, ReviewApiCatalogService } from "./services/reviewApiCatalogService.js";
import { IReviewApiSourceService, ReviewApiSourceService } from "./services/reviewApiSourceService.js";
import {
	IReviewCanvasEditorTabsService,
	ReviewCanvasEditorTabsService,
} from "./services/reviewCanvasEditorTabsService.js";
import {
	IReviewDesktopConnectionService,
	ReviewDesktopConnectionService,
} from "./services/reviewDesktopConnectionService.js";
import { IReviewTelemetryService, ReviewTelemetryService } from "./services/reviewTelemetryService.js";
import "./services/reviewLocalLanguageFeatures.js";

registerSingleton(IReviewDesktopConnectionService, ReviewDesktopConnectionService, InstantiationType.Eager);
registerSingleton(IReviewTelemetryService, ReviewTelemetryService, InstantiationType.Delayed);

registerSingleton(IReviewCanvasEditorTabsService, ReviewCanvasEditorTabsService, InstantiationType.Delayed);

registerSingleton(IReviewApiSourceService, ReviewApiSourceService, InstantiationType.Delayed);
registerSingleton(IReviewApiCatalogService, ReviewApiCatalogService, InstantiationType.Delayed);
registerSingleton(IReviewVerbsService, ReviewVerbsService, InstantiationType.Delayed);
registerSingleton(IReviewCanvasPartsService, ReviewCanvasParts, InstantiationType.Eager);
registerSingleton(IReviewExplorerPartsService, ReviewExplorerParts, InstantiationType.Eager);

import "./contrib/sharing/reviewSharing.contribution.js";
