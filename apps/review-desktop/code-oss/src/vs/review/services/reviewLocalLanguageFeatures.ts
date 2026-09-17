import { Queue } from "../../base/common/async.js";
import type { CancellationToken } from "../../base/common/cancellation.js";
import { Disposable, DisposableStore, type IReference } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { Position } from "../../editor/common/core/position.js";
import { Range } from "../../editor/common/core/range.js";
import type { Hover, LocationLink } from "../../editor/common/languages.js";
import type { ITextModel } from "../../editor/common/model.js";
import { IEditorWorkerService } from "../../editor/common/services/editorWorker.js";
import { ILanguageFeaturesService } from "../../editor/common/services/languageFeatures.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService, type IResolvedTextEditorModel } from "../../editor/common/services/resolverService.js";
import { getDefinitionsAtPosition, getImplementationsAtPosition, getTypeDefinitionsAtPosition } from "../../editor/contrib/gotoSymbol/browser/goToSymbol.js";
import { getHoversPromise } from "../../editor/contrib/hover/browser/getHover.js";
import { IFileService } from "../../platform/files/common/files.js";
import { ILogService } from "../../platform/log/common/log.js";
import { registerWorkbenchContribution2, WorkbenchPhase } from "../../workbench/common/contributions.js";
import { IExtensionService } from "../../workbench/services/extensions/common/extensions.js";
import { ITextFileService } from "../../workbench/services/textfile/common/textfiles.js";
import { IWorkspaceEditingService } from "../../workbench/services/workspaces/common/workspaceEditing.js";
import { REVIEW_UNIFIED_SCHEME } from "../common/reviewCodeResources.js";
import { REVIEW_API_SOURCE_SCHEME } from "./reviewApiSourceService.js";
import { IReviewCodeResourceService } from "./reviewCodeResourceService.js";
import { IReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";
import { withCurrentLocalContext } from "./reviewLocalRequest.js";
import { ReviewLocalLineMapping } from "./reviewLocalLineMapping.js";

interface LocalSource {
	generation: string;
	root: URI;
	reference: IReference<IResolvedTextEditorModel>;
	dispose(): void;
}

/** Review bytes remain pinned; language queries use the resolved project environment. */
export class ReviewLocalLanguageFeatures extends Disposable {
	static readonly ID = "review.localLanguageFeatures";
	private readonly sources = new Map<ITextModel, Promise<LocalSource | undefined>>();
	private readonly roots = new Map<string, number>();
	private readonly folders = this._register(new Queue<void>());
	private generation = 0;
	private readonly mappings = new WeakMap<ITextModel, { local: ITextModel; originalVersion: number; localVersion: number; value: ReviewLocalLineMapping }>();

	constructor(
		@IReviewDesktopConnectionService private readonly connection: IReviewDesktopConnectionService,
		@ITextModelService private readonly models: ITextModelService,
		@IModelService modelService: IModelService,
		@IEditorWorkerService private readonly worker: IEditorWorkerService,
		@ILanguageFeaturesService private readonly languages: ILanguageFeaturesService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IWorkspaceEditingService private readonly workspace: IWorkspaceEditingService,
		@ITextFileService private readonly textFiles: ITextFileService,
		@IFileService private readonly files: IFileService,
		@IReviewCodeResourceService private readonly resources: IReviewCodeResourceService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(files.onDidFilesChange(event => {
			if ([...this.roots.keys()].some(root => event.affects(URI.parse(root)))) this.generation++;
		}));
		// Warm language servers while source is being displayed, not at the first click.
		const warm = (model: ITextModel) => {
			if (model.uri.scheme === REVIEW_API_SOURCE_SCHEME) void this.localSource(model);
		};
		this._register(modelService.onModelAdded(warm));
		modelService.getModels().forEach(warm);
		const selector = { scheme: REVIEW_API_SOURCE_SCHEME, exclusive: true };
		this._register(languages.hoverProvider.register(selector, { provideHover: (model, position, token) => this.hover(model, position, token) }));
		this._register(languages.definitionProvider.register(selector, { provideDefinition: (model, position, token) => this.locations(model, position, token, "definition") }));
		// Unified hover/definition already delegate to the pinned side model.
		for (const scheme of [REVIEW_API_SOURCE_SCHEME, REVIEW_UNIFIED_SCHEME]) {
			const target = { scheme, exclusive: true };
			this._register(languages.typeDefinitionProvider.register(target, { provideTypeDefinition: (model, position, token) => this.locations(model, position, token, "type") }));
			this._register(languages.implementationProvider.register(target, { provideImplementation: (model, position, token) => this.locations(model, position, token, "implementation") }));
			this._register(languages.referenceProvider.register(target, {
				provideReferences: (model, position, context, token) => this.withSource(model, position, token, async (local, at, _mapping, pinned) => {
					const results = await Promise.all(languages.referenceProvider.ordered(local).map(provider => provider.provideReferences(local, at, context, token)));
					return this.reviewLocations(pinned, results.flatMap(result => result ?? []), token);
				}),
			}));
		}
	}

	private async localSource(model: ITextModel): Promise<LocalSource | undefined> {
		if (new URLSearchParams(model.uri.query).has("empty")) return undefined;
		try {
			const { serverUrl, token } = await this.connection.getConnection();
			const query = new URLSearchParams(model.uri.query);
			const params = new URLSearchParams({ version: query.get("version") ?? "", side: query.get("side") ?? "head" });
			if (query.has("commit")) params.set("commit", query.get("commit")!);
			const response = await fetch(`${serverUrl}/reviews-api/${encodeURIComponent(model.uri.authority)}/language-context?${params}`, {
				headers: { "x-review-token": token }, signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return undefined;
			const context: { rootPath: string | null; generation: string; state?: string } = await response.json();
			const cached = await this.sources.get(model);
			if (cached && cached.generation === context.generation && context.state !== "preparing" && context.rootPath) return cached;
			if (cached) { cached.dispose(); this.sources.delete(model); this.generation++; }
			if (!context.rootPath || context.state === "preparing" || context.state === "pending" || model.isDisposed()) return undefined;
			const pending = this.acquire(model, { rootPath: context.rootPath, generation: context.generation });
			this.sources.set(model, pending);
			const result = await pending;
			if (!result) this.sources.delete(model);
			return result;
		} catch (error) {
			this.sources.delete(model);
			this.log.debug("[Review] Language environment unavailable", error);
			return undefined;
		}
	}

	private async acquire(model: ITextModel, context: { rootPath: string; generation: string }): Promise<LocalSource | undefined> {
		const root = URI.file(context.rootPath);
		const relative = model.uri.path.slice(1);
		if (!relative || relative.split(/[\\/]/).some(part => part === "..")) return undefined;
		const resource = URI.joinPath(root, relative);
		if (!await this.files.exists(resource) || model.isDisposed()) return undefined;
		const owned = new DisposableStore();
		try {
			await this.folders.queue(async () => {
				const key = root.toString();
				if (!this.roots.has(key)) await this.workspace.addFolders([{ uri: root, name: `${root.path.split("/").at(-1)} (review environment)` }]);
				this.roots.set(key, (this.roots.get(key) ?? 0) + 1);
			});
			owned.add({ dispose: () => {
				void this.folders.queue(async () => {
					const count = (this.roots.get(root.toString()) ?? 1) - 1;
					if (count > 0) this.roots.set(root.toString(), count);
					else { this.roots.delete(root.toString()); await this.workspace.removeFolders([root]); }
				}).catch(error => this.log.warn("[Review] Could not release local workspace", error));
			} });
			const reference = owned.add(await this.models.createModelReference(resource));
			owned.add(reference.object.textEditorModel.onDidChangeContent(() => this.generation++));
			owned.add(model.onWillDispose(() => { this.sources.delete(model); owned.dispose(); }));
			if (model.isDisposed()) { owned.dispose(); return undefined; }
			await this.extensions.activateByEvent(`onLanguage:${reference.object.textEditorModel.getLanguageId()}`);
			return { root, reference, generation: context.generation, dispose: () => owned.dispose() };
		} catch (error) { owned.dispose(); throw error; }
	}

	private async withSource<T>(model: ITextModel, position: Position, token: CancellationToken, run: (local: ITextModel, at: Position, mapping: ReviewLocalLineMapping, review: ITextModel) => Promise<T>): Promise<T | undefined> {
		if (token.isCancellationRequested || model.isDisposed()) return undefined;
		if (model.uri.scheme === REVIEW_UNIFIED_SCHEME) {
			const unified = this.resources.unifiedResource(model.uri);
			const mapped = unified?.targetForRange(position.lineNumber, position.lineNumber);
			if (!mapped) return undefined;
			const ref = await this.models.createModelReference(mapped.side === "base" ? unified!.original : unified!.modified);
			try { return await this.withSource(ref.object.textEditorModel, new Position(mapped.startLine, position.column), token, run); }
			finally { ref.dispose(); }
		}
		const source = await this.localSource(model);
		if (!source || token.isCancellationRequested || model.isDisposed()) return undefined;
		const local = source.reference.object.textEditorModel;
		if (!await this.files.exists(local.uri)) return undefined;
		// Resolve current disk contents, preserving any unsaved local editor buffer.
		await this.textFiles.files.resolve(local.uri, { reload: { async: false } });
		return withCurrentLocalContext([model, local], token, () => this.generation, async valid => {
			const originalVersion = model.getVersionId(), localVersion = local.getVersionId();
			let cached = this.mappings.get(model);
			if (!cached || cached.local !== local || cached.originalVersion !== originalVersion || cached.localVersion !== localVersion) {
				const diff = await this.worker.computeDiff(model.uri, local.uri, { ignoreTrimWhitespace: false, maxComputationTimeMs: 1000, computeMoves: false }, "advanced");
				if (!diff || diff.quitEarly || !valid()) return undefined;
				cached = { local, originalVersion, localVersion, value: new ReviewLocalLineMapping(model, local, diff) };
				this.mappings.set(model, cached);
			}
			if (!valid()) return undefined;
			const at = cached.value.toLocal(position);
			if (!at || model.getLineContent(position.lineNumber) !== local.getLineContent(at.lineNumber)) return undefined;
			const result = await run(local, at, cached.value, model);
			const current = await this.localSource(model);
			return current?.generation === source.generation ? result : undefined;
		});
	}

	private hover(model: ITextModel, position: Position, token: CancellationToken): Promise<Hover | undefined> {
		return this.withSource(model, position, token, async (local, at, mapping) => {
			const hovers = await getHoversPromise(this.languages.hoverProvider, local, at, token);
			if (!hovers.length) return undefined;
			const range = hovers[0].range && mapping.toReview(Range.lift(hovers[0].range));
			if (!range) return undefined;
			return { range, contents: hovers.flatMap(hover => hover.contents) };
		});
	}

	private async locations(model: ITextModel, position: Position, token: CancellationToken, kind: "definition" | "type" | "implementation"): Promise<LocationLink[] | undefined> {
		return this.withSource(model, position, token, async (local, at, mapping, pinned) => {
			const results = kind === "definition" ? await getDefinitionsAtPosition(this.languages.definitionProvider, local, at, false, token)
				: kind === "type" ? await getTypeDefinitionsAtPosition(this.languages.typeDefinitionProvider, local, at, false, token)
				: await getImplementationsAtPosition(this.languages.implementationProvider, local, at, false, token);
			return this.reviewLocations(pinned, results.map(result => {
				let origin = result.originSelectionRange ? mapping.toReview(Range.lift(result.originSelectionRange)) : undefined;
				if (origin && model.uri.scheme === REVIEW_UNIFIED_SCHEME) {
					const unified = this.resources.unifiedResource(model.uri);
					const side = new URLSearchParams(pinned.uri.query).get("side");
					const row = unified?.rows.find(row => (side === "base" ? row.baseLine : row.headLine) === origin!.startLineNumber);
					origin = row && origin.startLineNumber === origin.endLineNumber
						? new Range(row.lineNumber, origin.startColumn, row.lineNumber, origin.endColumn) : undefined;
				}
				return { ...result, originSelectionRange: origin };
			}), token);
		});
	}

	/** Keep navigation in the same saved version/side only where destination bytes align. */
	private async reviewLocations<T extends LocationLink>(pinned: ITextModel, locations: T[], token: CancellationToken): Promise<T[]> {
		if (pinned.uri.scheme !== REVIEW_API_SOURCE_SCHEME) return locations;
		const source = await this.localSource(pinned);
		if (!source) return locations;
		const prefix = source.root.path.replace(/\/$/, "") + "/";
		// References often share a file. Resolve and diff each destination once per request.
		const groups = new Map<string, T[]>();
		for (const location of locations) {
			const key = location.uri.toString();
			const group = groups.get(key) ?? [];
			group.push(location);
			groups.set(key, group);
		}
		const mapped = new Map<T, T>();
		await Promise.all([...groups.values()].map(async group => {
			const target = group[0].uri;
			if (target.scheme !== "file" || target.authority !== source.root.authority || !target.path.startsWith(prefix)) return;
			const candidate = pinned.uri.with({ path: "/" + target.path.slice(prefix.length) });
			const owned = new DisposableStore();
			try {
				const original = owned.add(await this.models.createModelReference(candidate)).object.textEditorModel;
				const local = owned.add(await this.models.createModelReference(target)).object.textEditorModel;
				await this.textFiles.files.resolve(target, { reload: { async: false } });
				const results = await withCurrentLocalContext([original, local], token, () => this.generation, async () => {
					const diff = await this.worker.computeDiff(candidate, target, { ignoreTrimWhitespace: false, maxComputationTimeMs: 1000, computeMoves: false }, "advanced");
					if (!diff || diff.quitEarly) return [];
					const mapping = new ReviewLocalLineMapping(original, local, diff);
					return group.flatMap(location => {
						const range = mapping.toReview(Range.lift(location.range));
						const selection = location.targetSelectionRange && mapping.toReview(Range.lift(location.targetSelectionRange));
						if (!range || (location.targetSelectionRange && !selection)) return [];
						return [[location, { ...location, uri: candidate, range, ...(selection ? { targetSelectionRange: selection } : {}) }] as const];
					});
				});
				for (const [before, after] of results ?? []) mapped.set(before, after);
			} catch {
				// Dependencies, generated files, and newer files may have no saved counterpart.
			} finally {
				owned.dispose();
			}
		}));
		return locations.map(location => mapped.get(location) ?? location);
	}

	override dispose(): void {
		for (const pending of this.sources.values()) void pending.then(source => source?.dispose());
		this.sources.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(ReviewLocalLanguageFeatures.ID, ReviewLocalLanguageFeatures, WorkbenchPhase.BlockRestore);
