/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isThenable } from "../../base/common/async.js";
import { Codicon } from "../../base/common/codicons.js";
import { Disposable, type IDisposable } from "../../base/common/lifecycle.js";
import { Schemas } from "../../base/common/network.js";
import { basename, extUri, joinPath } from "../../base/common/resources.js";
import { ThemeIcon } from "../../base/common/themables.js";
import { URI } from "../../base/common/uri.js";
import type { IDocumentDiff } from "../../editor/common/diff/documentDiffProvider.js";
import type { ITextModel } from "../../editor/common/model.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { IEditorWorkerService } from "../../editor/common/services/editorWorker.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService, type ITextModelContentProvider } from "../../editor/common/services/resolverService.js";
import { ICommandService } from "../../platform/commands/common/commands.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IContextKeyService, RawContextKey, type IContextKey } from "../../platform/contextkey/common/contextkey.js";
import type { IResourceEditorInput, ITextEditorOptions } from "../../platform/editor/common/editor.js";
import { IFileService } from "../../platform/files/common/files.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../platform/log/common/log.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IStorageService } from "../../platform/storage/common/storage.js";
import { IWorkspaceContextService } from "../../platform/workspace/common/workspace.js";
import type { IWorkbenchContribution } from "../../workbench/common/contributions.js";
import { isResourceEditorInput, type IUntypedEditorInput } from "../../workbench/common/editor.js";
import { DecorationsService } from "../../workbench/services/decorations/browser/decorationsService.js";
import type { IDecorationData, IDecorationsProvider } from "../../workbench/services/decorations/common/decorations.js";
import { EditorResolverService } from "../../workbench/services/editor/browser/editorResolverService.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import type { ResolvedEditor } from "../../workbench/services/editor/common/editorResolverService.js";
import type { PreferredGroup } from "../../workbench/services/editor/common/editorService.js";
import { IExtensionService } from "../../workbench/services/extensions/common/extensions.js";

/** The workspace setting naming the base checkout the source folder is compared with. */
export const REVIEW_FILES_BASE_SETTING = "reviewFiles.base";

/** The base checkout from the workspace file; the registered setting defaults to empty everywhere. */
export function reviewFilesBase(configuration: IConfigurationService): string | undefined {
	const base = configuration.inspect<unknown>(REVIEW_FILES_BASE_SETTING).workspaceValue;
	return typeof base === "string" ? base : undefined;
}

/** An empty side for a file that exists only in the base or only in the head checkout. */
export const REVIEW_EMPTY_SOURCE_SCHEME = "review-empty";

/** How the source window shows a file: compared with the base, or one side alone. */
export type SourceMode = "diff" | "head" | "base";

export const SOURCE_MODE_CONTEXT = "reviewFiles.sourceMode";

/**
 * Open every source file as an inline diff against the base checkout, or as
 * the head or base file alone, however it is reached: the file tree, Quick
 * Open, search or a definition.
 */
export class NavigatorDiffEditorResolverService extends EditorResolverService {
	private mode: SourceMode = "diff";
	private readonly modeContext: IContextKey<SourceMode>;

	constructor(
		@IEditorGroupsService groups: IEditorGroupsService,
		@IInstantiationService services: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IQuickInputService quickInput: IQuickInputService,
		@INotificationService notifications: INotificationService,
		@IStorageService storage: IStorageService,
		@IExtensionService extensions: IExtensionService,
		@ILogService private readonly logs: ILogService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileService private readonly files: IFileService,
		@ITextModelService private readonly textModels: ITextModelService,
		@IEditorWorkerService private readonly editorWorker: IEditorWorkerService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(groups, services, configuration, quickInput, notifications, storage, extensions, logs);
		this.modeContext = new RawContextKey<SourceMode>(SOURCE_MODE_CONTEXT, "diff").bindTo(contextKeys);
	}

	/** Files opened from now on use the mode; open editors keep theirs until reopened. */
	setMode(mode: SourceMode): void {
		this.mode = mode;
		this.modeContext.set(mode);
	}

	/** The head file an empty side stands for, so it can be reopened in another mode. */
	sourceOf(resource: URI): URI {
		const headRoot = this.workspace.getWorkspace().folders[0]?.uri;
		return resource.scheme === REVIEW_EMPTY_SOURCE_SCHEME && headRoot ? joinPath(headRoot, resource.path) : resource;
	}

	override async resolveEditor(editor: IUntypedEditorInput, group: PreferredGroup | undefined): Promise<ResolvedEditor> {
		// A comparison that cannot be built opens the file itself.
		const compared = await this.compare(editor).catch(error => {
			this.logs.warn("Could not compare the source file with its base", error);
			return undefined;
		});
		return super.resolveEditor(compared ?? editor, group);
	}

	private async compare(editor: IUntypedEditorInput): Promise<IUntypedEditorInput | undefined> {
		if (!isResourceEditorInput(editor) || editor.resource.scheme !== Schemas.file) return undefined;
		const base = reviewFilesBase(this.configuration);
		const headRoot = this.workspace.getWorkspace().folders[0]?.uri;
		if (base === undefined || !headRoot) return undefined;
		const baseRoot = base ? URI.file(base) : undefined;
		if (baseRoot && !(await this.files.exists(baseRoot))) return undefined;

		const fromBase = !extUri.isEqualOrParent(editor.resource, headRoot);
		if (this.mode === "head" && !fromBase) return undefined;
		const relative = extUri.relativePath(fromBase && baseRoot ? baseRoot : headRoot, editor.resource);
		if (relative === undefined || relative === "") return undefined;

		// A renamed file pairs with its path on the other side.
		const counterpart = baseRoot ? await this.counterpart(fromBase ? "base" : "head", relative) : undefined;
		const headPath = fromBase ? (counterpart ?? relative) : relative;
		const head = joinPath(headRoot, headPath);
		const original = baseRoot && joinPath(baseRoot, fromBase ? relative : (counterpart ?? relative));
		const [inHead, inBase] = await Promise.all([this.files.exists(head), original ? this.files.exists(original) : false]);
		if (!inHead && !inBase) return undefined;

		const empty = URI.from({ scheme: REVIEW_EMPTY_SOURCE_SCHEME, path: `/${headPath}` });
		const originalSide = inBase && original ? original : empty;
		const modifiedSide = inHead ? head : empty;
		const shown = this.mode === "base" ? originalSide : modifiedSide;
		const label = { label: basename(head), description: headPath.includes("/") ? headPath.slice(0, headPath.lastIndexOf("/")) : undefined };
		const options = await this.revealed(editor, shown);
		if (this.mode === "diff") return { original: { resource: originalSide }, modified: { resource: modifiedSide }, ...label, options };
		return { resource: shown, ...label, options };
	}

	/** The editor's selection moved to where that line sits in the shown file. */
	private async revealed(editor: IResourceEditorInput, shown: URI): Promise<ITextEditorOptions | undefined> {
		const options = editor.options as ITextEditorOptions | undefined;
		const selection = options?.selection;
		if (!selection || extUri.isEqual(editor.resource, shown)) return options;
		const line = shown.scheme === Schemas.file ? await this.mappedLine(editor.resource, shown, selection.startLineNumber).catch(() => undefined) : undefined;
		return { ...options, selection: line === undefined ? undefined : { startLineNumber: line, startColumn: 1 } };
	}

	/** The review-files extension knows Git's renames; without it, paths pair as-is. */
	private async counterpart(side: "base" | "head", path: string): Promise<string | undefined> {
		try {
			const other = await this.commands.executeCommand<unknown>("reviewFiles.counterpart", side, path);
			return typeof other === "string" ? other : undefined;
		} catch {
			return undefined;
		}
	}

	private async mappedLine(from: URI, to: URI, line: number): Promise<number | undefined> {
		const references = await Promise.all([this.textModels.createModelReference(from), this.textModels.createModelReference(to)]);
		try {
			const diff: IDocumentDiff | null = await this.editorWorker.computeDiff(from, to, { ignoreTrimWhitespace: false, maxComputationTimeMs: 1000, computeMoves: false }, "advanced");
			if (!diff) return undefined;
			let offset = 0;
			for (const change of diff.changes) {
				if (line < change.original.startLineNumber) break;
				if (line < change.original.endLineNumberExclusive) return change.modified.startLineNumber;
				offset = change.modified.endLineNumberExclusive - change.original.endLineNumberExclusive;
			}
			return line + offset;
		} finally {
			for (const reference of references) reference.dispose();
		}
	}
}

/** Serves the empty side of an added or deleted file, in that file's language. */
export class NavigatorEmptySourceContentProvider extends Disposable implements IWorkbenchContribution, ITextModelContentProvider {
	constructor(
		@ITextModelService textModels: ITextModelService,
		@IModelService private readonly models: IModelService,
		@ILanguageService private readonly languages: ILanguageService,
	) {
		super();
		this._register(textModels.registerTextModelContentProvider(REVIEW_EMPTY_SOURCE_SCHEME, this));
	}

	async provideTextContent(resource: URI): Promise<ITextModel> {
		return this.models.getModel(resource) ?? this.models.createModel("", this.languages.createByFilepathOrFirstLine(resource), resource);
	}
}

/**
 * Every source file is read-only, so an open file's lock badge carries no
 * information and would hide its A/M/D badge: icon badges win over letters.
 * The Read-only tooltip remains.
 */
export class NavigatorDecorationsService extends DecorationsService {
	override registerDecorationsProvider(provider: IDecorationsProvider): IDisposable {
		const withoutLock = (data: IDecorationData | undefined) =>
			data && ThemeIcon.isThemeIcon(data.letter) && data.letter.id === Codicon.lockSmall.id ? { ...data, letter: undefined } : data;
		return super.registerDecorationsProvider({
			label: provider.label,
			onDidChange: provider.onDidChange,
			provideDecorations: (uri, token) => {
				const data = provider.provideDecorations(uri, token);
				return isThenable(data) ? data.then(withoutLock) : withoutLock(data);
			},
		});
	}
}
