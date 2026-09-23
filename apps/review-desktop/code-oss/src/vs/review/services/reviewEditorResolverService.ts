/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../platform/log/common/log.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IStorageService } from "../../platform/storage/common/storage.js";
import type { IUntypedEditorInput } from "../../workbench/common/editor.js";
import { EditorResolverService } from "../../workbench/services/editor/browser/editorResolverService.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { ResolvedStatus, type ResolvedEditor } from "../../workbench/services/editor/common/editorResolverService.js";
import type { PreferredGroup } from "../../workbench/services/editor/common/editorService.js";
import { IExtensionService } from "../../workbench/services/extensions/common/extensions.js";
import { IReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";

/** Redirect Review source files; the navigator keeps the stock resolver. */
export class ReviewEditorResolverService extends EditorResolverService {
	constructor(
		@IEditorGroupsService groups: IEditorGroupsService,
		@IInstantiationService private readonly services: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@IQuickInputService quickInput: IQuickInputService,
		@INotificationService notifications: INotificationService,
		@IStorageService storage: IStorageService,
		@IExtensionService extensions: IExtensionService,
		@ILogService log: ILogService,
	) {
		super(groups, services, configuration, quickInput, notifications, storage, extensions, log);
	}

	override async resolveEditor(editor: IUntypedEditorInput, group: PreferredGroup | undefined): Promise<ResolvedEditor> {
		// Resolve lazily: the tabs service itself depends on IEditorService.
		const opened = await this.services.invokeFunction(accessor => accessor.get(IReviewCanvasEditorTabsService).openSourceEditor(editor));
		return opened ? ResolvedStatus.ABORT : super.resolveEditor(editor, group);
	}
}
