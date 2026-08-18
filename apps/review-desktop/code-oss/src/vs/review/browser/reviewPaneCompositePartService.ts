/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import type { IProgressIndicator } from '../../platform/progress/common/progress.js';
import { Extensions as PaneCompositeExtensions, type PaneCompositeDescriptor } from '../../workbench/browser/panecomposite.js';
import type { IPaneComposite } from '../../workbench/common/panecomposite.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { Parts, type SINGLE_WINDOW_PARTS } from '../../workbench/services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';

/** Supplies the pane-composite contract without creating chrome that Review does not show. */
class ReviewPaneCompositePartService implements IPaneCompositePartService {
	declare readonly _serviceBrand: undefined;

	readonly onDidPaneCompositeOpen = Event.None;
	readonly onDidPaneCompositeClose = Event.None;

	getRegistryId(location: ViewContainerLocation): string {
		switch (location) {
			case ViewContainerLocation.Sidebar:
				return PaneCompositeExtensions.Viewlets;
			case ViewContainerLocation.Panel:
				return PaneCompositeExtensions.Panels;
			case ViewContainerLocation.AuxiliaryBar:
				return PaneCompositeExtensions.Auxiliary;
		}
	}

	getPartId(location: ViewContainerLocation): SINGLE_WINDOW_PARTS {
		switch (location) {
			case ViewContainerLocation.Sidebar:
				return Parts.SIDEBAR_PART;
			case ViewContainerLocation.Panel:
				return Parts.PANEL_PART;
			case ViewContainerLocation.AuxiliaryBar:
				return Parts.AUXILIARYBAR_PART;
		}
	}

	openPaneComposite(_id: string | undefined, _location: ViewContainerLocation, _focus?: boolean): Promise<IPaneComposite | undefined> {
		return Promise.resolve(undefined);
	}

	getActivePaneComposite(_location: ViewContainerLocation): IPaneComposite | undefined { return undefined; }
	getPaneComposite(_id: string, _location: ViewContainerLocation): PaneCompositeDescriptor | undefined { return undefined; }
	getPaneComposites(_location: ViewContainerLocation): PaneCompositeDescriptor[] { return []; }
	getPinnedPaneCompositeIds(_location: ViewContainerLocation): string[] { return []; }
	getVisiblePaneCompositeIds(_location: ViewContainerLocation): string[] { return []; }
	getPaneCompositeIds(_location: ViewContainerLocation): string[] { return []; }
	getProgressIndicator(_id: string, _location: ViewContainerLocation): IProgressIndicator | undefined { return undefined; }
	hideActivePaneComposite(_location: ViewContainerLocation): void { }
	getLastActivePaneCompositeId(_location: ViewContainerLocation): string { return ''; }
}

registerSingleton(IPaneCompositePartService, ReviewPaneCompositePartService, InstantiationType.Delayed);
