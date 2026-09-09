/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../workbench/common/contributions.js';
import { ReviewMigrationNotification } from '../../browser/reviewMigrationNotification.js';

registerWorkbenchContribution2('workbench.contrib.devfast.reviewMigration', ReviewMigrationNotification, WorkbenchPhase.AfterRestored);
