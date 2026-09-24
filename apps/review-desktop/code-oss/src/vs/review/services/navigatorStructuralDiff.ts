/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation, raceTimeout } from "../../base/common/async.js";
import type { CancellationToken } from "../../base/common/cancellation.js";
import { isCancellationError } from "../../base/common/errors.js";
import { Event } from "../../base/common/event.js";
import { Disposable, DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { Schemas } from "../../base/common/network.js";
import { extUri } from "../../base/common/resources.js";
import type { URI } from "../../base/common/uri.js";
import { WorkerBasedDocumentDiffProvider, type IDiffProviderFactoryService, type IDocumentDiffFactoryOptions } from "../../editor/browser/widget/diffEditor/diffProviderFactoryService.js";
import type { IDocumentDiff, IDocumentDiffProvider, IDocumentDiffProviderOptions } from "../../editor/common/diff/documentDiffProvider.js";
import type { ITextModel } from "../../editor/common/model.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { IMainProcessService } from "../../platform/ipc/common/mainProcessService.js";
import { ILogService } from "../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../platform/workspace/common/workspace.js";
import { REVIEW_STRUCTURAL_DIFF_SETTING } from "../common/reviewConfigurationDefaults.js";
import { REVIEW_DESKTOP_CHANNEL, REVIEW_DESKTOP_CONNECTION_VERSION, type ReviewDesktopConnection } from "../common/reviewDesktopBootstrap.js";
import type { ReviewSourceView } from "../common/reviewProtocol.js";
import { REVIEW_EMPTY_SOURCE_SCHEME } from "./navigatorDiffEditorResolverService.js";
import { attachStructuralEditors, StructuralDiffProvider } from "./reviewStructuralDiff.js";
import { StructuralDiffClient } from "./reviewStructuralDiffClient.js";
import { StructuralDiffSession } from "./reviewStructuralDiffSession.js";

/** The Review comparison a source window shows, written by Whiteboard into its workspace. */
export const REVIEW_FILES_REVIEW_SETTING = "reviewFiles.review";

/** How long a file waits for diffr before showing the line diff; diffr's result replaces it when it arrives. */
const STRUCTURAL_WAIT_MS = 2000;

/**
 * Source-window diffs come from diffr, as the Review window's Diff tab does.
 * A file diffr does not cover, or whose structural diff fails, shows the
 * editor's own line diff instead.
 */
export class NavigatorDiffProviderFactoryService extends Disposable implements IDiffProviderFactoryService {
	declare readonly _serviceBrand: undefined;
	private session: StructuralDiffSession | undefined;

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IMainProcessService private readonly mainProcess: IMainProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILogService private readonly logs: ILogService,
	) {
		super();
	}

	createDiffProvider(options: IDocumentDiffFactoryOptions): IDocumentDiffProvider {
		const lines = this.instantiation.createInstance(WorkerBasedDocumentDiffProvider, options);
		const session = this.structural();
		return session ? new NavigatorStructuralDiffProvider(session, lines, (original, modified) => this.pathOf(original, modified), this.logs) : new WholeFileDiffProvider(lines);
	}

	/** One diffr comparison per window, started by the first diff. */
	private structural(): StructuralDiffSession | undefined {
		if (this.session) return this.session;
		// The Review window's setting, which defaults to on.
		if (this.configuration.getValue<boolean>(REVIEW_STRUCTURAL_DIFF_SETTING) === false) return undefined;
		const view = this.configuration.inspect<ReviewSourceView>(REVIEW_FILES_REVIEW_SETTING).workspaceValue;
		if (typeof view?.reviewId !== "string" || typeof view.version !== "number") return undefined;
		const connection = { getConnection: () => this.connection() };
		const session = this._register(new StructuralDiffSession(new StructuralDiffClient(connection, view)));
		void session.start();
		// Bands a reader opens stay open when the diff is recomputed.
		attachStructuralEditors(this.instantiation, (original, modified) => this.pathOf(original, modified), session, this._register(new DisposableStore()));
		this.session = session;
		return session;
	}

	private async connection(): Promise<{ serverUrl: string; token: string }> {
		const connection = await this.mainProcess.getChannel(REVIEW_DESKTOP_CHANNEL).call<ReviewDesktopConnection>("getConnection");
		if (connection?.version !== REVIEW_DESKTOP_CONNECTION_VERSION) throw new Error(`Unsupported Whiteboard Desktop connection version: ${String(connection?.version)}.`);
		return { serverUrl: connection.url, token: connection.token };
	}

	/** diffr names a file by its head path, or its base path when it was deleted: the path the modified side stands for. */
	private pathOf(original: URI, modified: URI): string | undefined {
		if (modified.scheme === REVIEW_EMPTY_SOURCE_SCHEME) return original.scheme === Schemas.file ? modified.path.slice(1) : undefined;
		const head = this.workspace.getWorkspace().folders[0]?.uri;
		const path = head && modified.scheme === Schemas.file ? extUri.relativePath(head, modified) : undefined;
		return path || undefined;
	}
}

/** The line diff over the whole file: an empty set of supplied gaps keeps every unchanged line in view. */
class WholeFileDiffProvider implements IDocumentDiffProvider, IDisposable {
	readonly onDidChange: Event<void>;

	constructor(private readonly lines: WorkerBasedDocumentDiffProvider) {
		this.onDidChange = lines.onDidChange;
	}

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		return { ...await this.lines.computeDiff(original, modified, options, token), contextGaps: [] };
	}

	dispose(): void {
		this.lines.dispose();
	}
}

class NavigatorStructuralDiffProvider extends WholeFileDiffProvider {
	private path: string | undefined;
	override readonly onDidChange: Event<void>;

	constructor(
		private readonly session: StructuralDiffSession,
		lines: WorkerBasedDocumentDiffProvider,
		private readonly pathOf: (original: URI, modified: URI) => string | undefined,
		private readonly logs: ILogService,
	) {
		super(lines);
		// diffr's result for the shown file replaces the line diff, and its fold changes redraw it.
		const structural = Event.filter(session.onDidChange, change => this.path !== undefined && change.files.has(this.path));
		this.onDidChange = Event.any(lines.onDidChange, Event.map(structural, () => undefined));
	}

	override async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		const originalUri = original.uri.with({ fragment: "" }), modifiedUri = modified.uri.with({ fragment: "" });
		const path = this.pathOf(originalUri, modifiedUri);
		this.path = path;
		if (path !== undefined && await this.ready(path, token) && this.session.getTextDiff(path)) {
			try {
				const pairs = new Map([[originalUri.toString() + "\n" + modifiedUri.toString(), path]]);
				return await new StructuralDiffProvider(this.session, pairs, new Set()).computeDiff(original, modified, options, token);
			} catch (error) {
				if (isCancellationError(error)) throw error;
				this.logs.warn(`Showing the line diff for ${path}`, error);
			}
		}
		return super.computeDiff(original, modified, options, token);
	}

	/** Whether diffr has settled the file, waiting briefly for a result it is still computing. */
	private async ready(path: string, token: CancellationToken): Promise<boolean> {
		const settled = () => this.session.error !== undefined || this.session.covers(path) === false || this.session.getFileResult(path) !== undefined || this.session.complete;
		if (!settled()) {
			const store = new DisposableStore();
			const change = new Promise<void>(resolve => {
				const check = () => { if (settled()) resolve(); };
				store.add(this.session.onDidChange(check));
			});
			await raceCancellation(raceTimeout(change, STRUCTURAL_WAIT_MS), token).finally(() => store.dispose());
		}
		return this.session.getFileResult(path) !== undefined;
	}
}
