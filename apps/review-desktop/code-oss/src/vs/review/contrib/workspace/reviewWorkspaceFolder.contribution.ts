/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Queue } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import {
	registerWorkbenchContribution2,
	WorkbenchPhase,
	type IWorkbenchContribution
} from '../../../workbench/common/contributions.js';
import { IWorkspaceEditingService } from '../../../workbench/services/workspaces/common/workspaceEditing.js';
import { reviewWorkspaceFolder } from '../../common/reviewWorkspaceFolder.js';
import {
	IReviewSessionModelService,
	type ReviewDesktopSession
} from '../../services/reviewSessionModelService.js';

/**
 * Keeps the workbench's single workspace folder pointed at the repository the
 * active review session is reviewing.
 *
 * Review binds both `IWorkspaceContextService` and `IWorkspaceEditingService` to
 * `SessionsWorkspaceContextService`, which starts with no folders at all. With
 * an empty workspace no `workspaceContains:` event fires and language servers
 * have no project to index, so reviewed files get single-file answers only: no
 * diagnostics, no cross-file go-to-definition, and unresolved imports.
 *
 * That shim mutates folders in memory — no workspace file is written, no window
 * reloads, and the extension host is not restarted — so swapping the folder as
 * sessions change is cheap. The extension host re-runs `workspaceContains:` for
 * added folders on its own.
 */
class ReviewWorkspaceFolderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'review.contrib.workspaceFolder';

	private readonly queue = this._register(new Queue<void>());

	constructor(
		@IReviewSessionModelService private readonly sessionModelService: IReviewSessionModelService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.sessionModelService.onDidChangeActiveModel(model =>
			this.queue.queue(() => this.apply(model?.session ?? null))));

		// Folders live in memory only, so a reloaded window starts with none and
		// the active-model event may already have fired. Seed from its current value.
		this.queue.queue(() =>
			this.apply(this.sessionModelService.activeModel?.session ?? null));
	}

	private async apply(session: ReviewDesktopSession | null): Promise<void> {
		const target = reviewWorkspaceFolder(session, session?.review.title);
		const current = this.workspaceContextService.getWorkspace().folders[0]?.uri;

		if (!target) {
			if (current) {
				await this.workspaceEditingService.removeFolders([current], true);
			}
			return;
		}

		if (current && this.uriIdentityService.extUri.isEqual(current, target.uri)) {
			return;
		}

		// A single `updateFolders` keeps this to one folder-change event, so a
		// language server sees one transition rather than a remove then an add.
		if (current) {
			await this.workspaceEditingService.updateFolders(0, 1, [target], true);
		} else {
			await this.workspaceEditingService.addFolders([target], true);
		}

		this.logService.trace(`[review] workspace folder is now ${target.uri.fsPath}`);
	}
}

registerWorkbenchContribution2(
	ReviewWorkspaceFolderContribution.ID,
	ReviewWorkspaceFolderContribution,
	WorkbenchPhase.BlockRestore,
);

export { ReviewWorkspaceFolderContribution };
