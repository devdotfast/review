/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IWorkbenchOptions, ReviewWorkbench } from './workbench.js';

export function createReviewWorkbench(
	parent: HTMLElement,
	options: IWorkbenchOptions | undefined,
	serviceCollection: ServiceCollection,
	logService: ILogService,
): ReviewWorkbench {
	return new ReviewWorkbench(parent, options, serviceCollection, logService);
}
