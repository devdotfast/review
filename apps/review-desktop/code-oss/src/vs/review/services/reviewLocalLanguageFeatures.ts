import type { CancellationToken } from "../../base/common/cancellation.js";
import { Disposable, DisposableStore, type IReference } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { Position } from "../../editor/common/core/position.js";
import type { Hover, LocationLink } from "../../editor/common/languages.js";
import type { ITextModel } from "../../editor/common/model.js";
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
import { reviewSourceQuery, type ReviewLanguageEnvironment } from "../common/reviewProtocol.js";
import { sourceLocation } from "../common/reviewSourceView.js";
import { REVIEW_LANGUAGE_SOURCE_SCHEME } from "../common/reviewReadonlySource.js";
import { REVIEW_API_SOURCE_SCHEME } from "./reviewApiSourceService.js";
import { IReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";
import { withCurrentLocalContext } from "./reviewLocalRequest.js";
import { acquireReviewLanguageRoot } from "./reviewLocalWorkspace.js";
import { ReviewLanguageEnvironmentRequests } from "./reviewLanguageEnvironmentRequests.js";

interface LocalSource {
	identity: string;
	root: URI;
	reference: IReference<IResolvedTextEditorModel>;
	dispose(): void;
}

/** Review bytes remain pinned; language queries use the resolved project environment. */
export class ReviewLocalLanguageFeatures extends Disposable {
	static readonly ID = "review.localLanguageFeatures";
	private readonly sources = new Map<ITextModel, { identity: string; rootPath: string; pending: Promise<LocalSource | undefined> }>();
	private readonly environments = new ReviewLanguageEnvironmentRequests();
	private readonly roots = new Map<string, number>();
	private readonly uncertainRoots = new Set<string>();
	private generation = 0;

	constructor(
		@IReviewDesktopConnectionService private readonly connection: IReviewDesktopConnectionService,
		@ITextModelService private readonly models: ITextModelService,
		@IModelService modelService: IModelService,
		@ILanguageFeaturesService private readonly languages: ILanguageFeaturesService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IWorkspaceEditingService private readonly workspace: IWorkspaceEditingService,
		@ITextFileService private readonly textFiles: ITextFileService,
		@IFileService private readonly files: IFileService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(connection.onDidChangeConnection(() => {
			this.environments.invalidate();
			this.generation++;
			for (const entry of this.sources.values()) {
				this.uncertainRoots.add(URI.file(entry.rootPath).toString());
				void entry.pending.then(source => source?.dispose());
			}
			this.sources.clear();
		}));
		this._register(files.onDidFilesChange(event => {
			if ([...this.roots.keys()].some(root => event.affects(URI.parse(root)))) this.generation++;
		}));
		// Warm language servers while source is being displayed, not at the first click.
		const warm = (model: ITextModel) => {
			if ([REVIEW_API_SOURCE_SCHEME, REVIEW_LANGUAGE_SOURCE_SCHEME].includes(model.uri.scheme)) void this.localSource(model);
		};
		this._register(modelService.onModelAdded(warm));
		modelService.getModels().forEach(warm);
		for (const scheme of [REVIEW_API_SOURCE_SCHEME, REVIEW_LANGUAGE_SOURCE_SCHEME]) {
			const selector = { scheme, exclusive: true };
			this._register(languages.hoverProvider.register(selector, { provideHover: (model, position, token) => this.hover(model, position, token) }));
			this._register(languages.definitionProvider.register(selector, { provideDefinition: (model, position, token) => this.locations(model, position, token, "definition") }));
		}
		// Unified hover/definition already delegate to the pinned side model.
		for (const scheme of [REVIEW_API_SOURCE_SCHEME, REVIEW_LANGUAGE_SOURCE_SCHEME]) {
			const target = { scheme, exclusive: true };
			this._register(languages.typeDefinitionProvider.register(target, { provideTypeDefinition: (model, position, token) => this.locations(model, position, token, "type") }));
			this._register(languages.implementationProvider.register(target, { provideImplementation: (model, position, token) => this.locations(model, position, token, "implementation") }));
			this._register(languages.referenceProvider.register(target, {
				provideReferences: (model, position, context, token) => this.withSource(model, position, token, async (local, at, pinned) => {
					const results = await Promise.all(languages.referenceProvider.ordered(local).map(provider => provider.provideReferences(local, at, context, token)));
					return this.reviewLocations(pinned, results.flatMap(result => result ?? []), token);
				}),
			}));
		}
	}

	private async environment(model: ITextModel, validate = false): Promise<ReviewLanguageEnvironment | undefined> {
		const { serverUrl, token } = await this.connection.getConnection();
		const target = sourceLocation(model.uri);
		return this.environments.read(JSON.stringify([serverUrl, token]), target.view, target.side, async () => {
			const params = new URLSearchParams({ side: target.side });
			for (const [key, value] of Object.entries(reviewSourceQuery(target.view))) {
				if (value !== undefined) params.set(key, String(value));
			}
			const response = await fetch(`${serverUrl}/reviews-api/${encodeURIComponent(model.uri.authority)}/language-context?${params}`, {
				headers: { "x-review-token": token }, signal: AbortSignal.timeout(10_000),
			});
			return response.ok ? response.json() : undefined;
		}, validate);
	}

	private async localSource(model: ITextModel): Promise<LocalSource | undefined> {
		if (new URLSearchParams(model.uri.query).has("empty")) return undefined;
		try {
			const epoch = this.environments.generation;
			const context = await this.environment(model);
			if (epoch !== this.environments.generation || model.isDisposed()) return undefined;
			const cached = this.sources.get(model);
			if (cached && cached.identity === context?.identity && cached.rootPath === context.rootPath) return cached.pending;
			if (cached) {
				this.uncertainRoots.add(URI.file(cached.rootPath).toString());
				void cached.pending.then(source => source?.dispose());
				this.sources.delete(model);
				this.generation++;
			}
			if (!context?.rootPath) return undefined;
			const pending = this.acquire(model, { rootPath: context.rootPath, identity: context.identity }).catch(error => {
				this.log.debug("[Whiteboard] Language model unavailable", error);
				return undefined;
			});
			const entry = { identity: context.identity, rootPath: context.rootPath, pending };
			this.sources.set(model, entry);
			const result = await pending;
			if (this.sources.get(model) !== entry || epoch !== this.environments.generation) { result?.dispose(); return undefined; }
			if (!result) this.sources.delete(model);
			return result;
		} catch (error) {
			const cached = this.sources.get(model);
			if (cached) this.uncertainRoots.add(URI.file(cached.rootPath).toString());
			this.log.debug("[Whiteboard] Language environment unavailable", error);
			return undefined;
		}
	}

	private async acquire(model: ITextModel, context: { rootPath: string; identity: string }): Promise<LocalSource | undefined> {
		const root = URI.file(context.rootPath);
		const relative = model.uri.path.slice(1);
		if (!relative || relative.split(/[\\/]/).some(part => part === "..")) return undefined;
		const resource = model.uri.scheme === REVIEW_LANGUAGE_SOURCE_SCHEME ? URI.file(model.uri.path) : URI.joinPath(root, relative);
		if (!await this.files.exists(resource) || model.isDisposed()) return undefined;
		const owned = new DisposableStore();
		try {
			owned.add(await acquireReviewLanguageRoot(this.workspace, root));
			this.roots.set(root.toString(), (this.roots.get(root.toString()) ?? 0) + 1);
			owned.add({
				dispose: () => {
					const count = (this.roots.get(root.toString()) ?? 1) - 1;
					if (count > 0) this.roots.set(root.toString(), count);
					else this.roots.delete(root.toString());
				}
			});
			const reference = owned.add(await this.models.createModelReference(resource));
			owned.add(reference.object.textEditorModel.onDidChangeContent(() => this.generation++));
			owned.add(model.onWillDispose(() => { this.sources.delete(model); owned.dispose(); }));
			if (model.isDisposed()) { owned.dispose(); return undefined; }
			await this.extensions.activateByEvent(`onLanguage:${reference.object.textEditorModel.getLanguageId()}`);
			if (model.isDisposed()) { owned.dispose(); return undefined; }
			return { root, reference, identity: context.identity, dispose: () => owned.dispose() };
		} catch (error) { owned.dispose(); throw error; }
	}

	private async withSource<T>(model: ITextModel, position: Position, token: CancellationToken, run: (local: ITextModel, at: Position, review: ITextModel) => Promise<T>): Promise<T | undefined> {
		if (token.isCancellationRequested || model.isDisposed()) return undefined;
		if (model.uri.scheme === "file") return withCurrentLocalContext([model], token, () => this.generation, async () => run(model, position, model));
		const epoch = this.environments.generation;
		const source = await this.localSource(model);
		if (!source || token.isCancellationRequested || model.isDisposed()) return undefined;
		const local = source.reference.object.textEditorModel;
		if (!await this.files.exists(local.uri)) { this.uncertainRoots.add(source.root.toString()); return undefined; }
		if (this.uncertainRoots.has(source.root.toString())) {
			// An open dependency can outlive a removed checkout and miss subsequent
			// watcher updates. Until watcher readiness is authoritative, revalidate
			// clean native buffers before querying; never replace a dirty buffer.
			const prefix = source.root.path.replace(/\/$/, "") + "/";
			await Promise.all(this.textFiles.files.models.filter(file => !file.isDirty() && file.resource.scheme === "file" && file.resource.path.startsWith(prefix))
				.map(file => this.textFiles.files.resolve(file.resource, { reload: { async: false } })));
		}
		// Resolve current disk contents, preserving any unsaved local editor buffer.
		await this.textFiles.files.resolve(local.uri, { reload: { async: false } });
		return withCurrentLocalContext([model, local], token, () => this.generation, async () => {
			// The language server must see exactly the source displayed in the review.
			if (!model.equalsTextBuffer(local.getTextBuffer())) return undefined;
			const result = await run(local, position, model);
			const current = await this.environment(model, true).catch(() => undefined);
			if (epoch === this.environments.generation && current?.rootPath === source.root.fsPath && current.identity === source.identity) return result;
			// Failed validation must also release the old workspace/watchers. Keeping
			// them after deletion can leave the language server blind to later edits.
			const cached = this.sources.get(model);
			if (cached?.identity === source.identity && cached.rootPath === source.root.fsPath) {
				this.uncertainRoots.add(source.root.toString());
				this.sources.delete(model);
				void cached.pending.then(value => value?.dispose());
				this.generation++;
			}
			return undefined;
		});
	}

	private hover(model: ITextModel, position: Position, token: CancellationToken): Promise<Hover | undefined> {
		return this.withSource(model, position, token, async (local, at) => {
			const hovers = await getHoversPromise(this.languages.hoverProvider, local, at, token);
			if (!hovers.length) return undefined;
			const range = hovers[0].range;
			if (!range) return undefined;
			return { range, contents: hovers.flatMap(hover => hover.contents) };
		});
	}

	private async locations(model: ITextModel, position: Position, token: CancellationToken, kind: "definition" | "type" | "implementation"): Promise<LocationLink[] | undefined> {
		return this.withSource(model, position, token, async (local, at, pinned) => {
			const results = kind === "definition" ? await getDefinitionsAtPosition(this.languages.definitionProvider, local, at, false, token)
				: kind === "type" ? await getTypeDefinitionsAtPosition(this.languages.typeDefinitionProvider, local, at, false, token)
				: await getImplementationsAtPosition(this.languages.implementationProvider, local, at, false, token);
			return this.reviewLocations(pinned, results, token);
		});
	}

	/** Keep navigation in the same saved version/side only when destination contents match. */
	private async reviewLocations<T extends LocationLink>(pinned: ITextModel, locations: T[], token: CancellationToken): Promise<T[]> {
		if (![REVIEW_API_SOURCE_SCHEME, REVIEW_LANGUAGE_SOURCE_SCHEME].includes(pinned.uri.scheme)) return locations;
		const source = await this.sources.get(pinned)?.pending;
		if (!source) return [];
		const prefix = source.root.path.replace(/\/$/, "") + "/";
		// References often share a file. Resolve and compare each destination once per request.
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
			if (target.scheme !== "file") return;
			const owned = new DisposableStore();
			try {
				const local = owned.add(await this.models.createModelReference(target)).object.textEditorModel;
				await this.textFiles.files.resolve(target, { reload: { async: false } });
				let original: ITextModel | undefined;
				if (target.authority === source.root.authority && target.path.startsWith(prefix)) {
					const candidate = pinned.uri.with({ scheme: REVIEW_API_SOURCE_SCHEME, path: "/" + target.path.slice(prefix.length) });
					try { original = owned.add(await this.models.createModelReference(candidate)).object.textEditorModel; }
					catch { /* Dependencies and generated files may have no review counterpart. */ }
				}
				if (!original?.equalsTextBuffer(local.getTextBuffer())) {
					const candidate = pinned.uri.with({ scheme: REVIEW_LANGUAGE_SOURCE_SCHEME, path: target.path });
					original = owned.add(await this.models.createModelReference(candidate)).object.textEditorModel;
				}
				const destination = original;
				const results = await withCurrentLocalContext([original, local], token, () => this.generation, async () => {
					if (!destination.equalsTextBuffer(local.getTextBuffer())) return [];
					return group.map(location => [location, { ...location, uri: destination.uri }] as const);
				});
				for (const [before, after] of results ?? []) mapped.set(before, after);
			} catch {
				// Missing destinations cannot be presented at the provider's coordinates.
			} finally {
				owned.dispose();
			}
		}));
		return locations.flatMap(location => {
			const match = mapped.get(location);
			return match ? [match] : [];
		});
	}

	override dispose(): void {
		this.environments.invalidate();
		for (const entry of this.sources.values()) void entry.pending.then(source => source?.dispose());
		this.sources.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(ReviewLocalLanguageFeatures.ID, ReviewLocalLanguageFeatures, WorkbenchPhase.BlockRestore);
