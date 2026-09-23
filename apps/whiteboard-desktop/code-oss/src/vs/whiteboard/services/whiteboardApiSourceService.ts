import { orderWhiteboardDiffFiles } from "../common/whiteboardChangedFilesModel.js";
import { lensFiles } from "../common/whiteboardLensFiles.js";
import { StructuralDiffClient } from "./whiteboardStructuralDiffClient.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import type { ITextModel } from "../../editor/common/model.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { IFileService, type IFileStat } from "../../platform/files/common/files.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import type {
	WhiteboardInlineFindSpec,
	WhiteboardDiffLens,
	WhiteboardInlineEditorRange,
	WhiteboardDiffFileWire,
	WhiteboardInlineEditorFactory,
	WhiteboardDiffViewFactory,
	SessionSourceEntry,
	WhiteboardApiSourceLocation,
} from "../common/whiteboardProtocol.js";
import { resolveWhiteboardSourceView, whiteboardSourceAnchor, whiteboardSourceComparison, whiteboardSourceQuery, type WhiteboardSourceView } from "../common/whiteboardProtocol.js";
import { WHITEBOARD_LANGUAGE_SOURCE_SCHEME } from "../common/whiteboardReadonlySource.js";
import { apiSourceUri, sourceLocation, sourceTreeUri, sourceTreeSelection, WHITEBOARD_API_TREE_SCHEME, WHITEBOARD_API_SOURCE_SCHEME } from "../common/whiteboardSourceView.js";
import { IWhiteboardCanvasEditorTabsService } from "./whiteboardCanvasEditorTabsService.js";
import { IWhiteboardDesktopConnectionService, whiteboardResponseError } from "./whiteboardDesktopConnectionService.js";
import type { WhiteboardDiffViewService, WhiteboardDiffViewSource } from "./whiteboardDiffViewService.js";
import type { WhiteboardEmbeddedEditors } from "./whiteboardEmbeddedEditors.js";

export { apiSourceUri, WHITEBOARD_API_SOURCE_SCHEME } from "../common/whiteboardSourceView.js";

/** The query that distinguishes one comparison's diff models from another's. */
function comparisonQuery(view: WhiteboardSourceView): string | undefined {
	const params = new URLSearchParams();
	if (view.commit) params.set("commit", view.commit);
	if (view.pins) {
		params.set("repositoryId", view.pins.repositoryId);
		params.set("head", view.pins.head);
		if (view.pins.base) params.set("base", view.pins.base);
	}
	const query = params.toString();
	return query || undefined;
}

export type ApiSourceTarget = WhiteboardApiSourceLocation;

/** Recover the immutable source identity even when no legacy session is active. */
export function apiSourceTarget(resource: URI): ApiSourceTarget | undefined {
	if (resource.scheme !== WHITEBOARD_API_SOURCE_SCHEME) return undefined;
	const query = new URLSearchParams(resource.query);
	const version = Number(query.get("version"));
	const side = query.get("side");
	if (
		!resource.authority ||
		!query.has("version") ||
		!Number.isInteger(version) ||
		version < 0 ||
		(side !== "base" && side !== "head")
	)
		return undefined;
	return {
		view: { sessionId: resource.authority, version, commit: query.get("commit") ?? undefined, generation: query.get("generation") ?? undefined },
		side,
		file: resource.path.slice(1),
	};
}

export const IWhiteboardApiSourceService = createDecorator<IWhiteboardApiSourceService>("whiteboardApiSourceService");
export interface IWhiteboardApiSourceService {
	readonly _serviceBrand: undefined;
	open(target: ApiSourceTarget, range?: WhiteboardInlineEditorRange): Promise<void>;
	children(resource: URI): Promise<IFileStat[]>;
	openDiff(view: WhiteboardSourceView, path: string): Promise<void>;
	canvas(
		view: () => WhiteboardSourceView,
		inline: WhiteboardEmbeddedEditors,
		diff: WhiteboardDiffViewService,
	): {
		inlineEditors: WhiteboardInlineEditorFactory;
		diffView: WhiteboardDiffViewFactory;
		openStructuralComparison(): void;
	};
}

/** Resolve native or retained resources once; all review surfaces share this path. */
export class WhiteboardApiSourceService extends Disposable implements IWhiteboardApiSourceService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IWhiteboardDesktopConnectionService private readonly session: IWhiteboardDesktopConnectionService,
		@ITextModelService models: ITextModelService,
		@IModelService modelService: IModelService,
		@ILanguageService languages: ILanguageService,
		@IEditorService private readonly editors: IEditorService,
		@IWhiteboardCanvasEditorTabsService private readonly tabs: IWhiteboardCanvasEditorTabsService,
		@IFileService private readonly files: IFileService,
	) {
		super();
		this._register(
			models.registerTextModelContentProvider(WHITEBOARD_API_SOURCE_SCHEME, {
				provideTextContent: async (resource) => {
					const existing = modelService.getModel(resource);
					if (existing) return existing;
					const query = new URLSearchParams(resource.query);
					const target = sourceLocation(resource);
					const body = query.has("empty")
						? { text: "" }
						: await this.read<{ text: string; localPath?: string }>(target.view.sessionId, "/file", { ...whiteboardSourceQuery(target.view), side: target.side, file: target.file });
					const model = (
						modelService.getModel(resource) ??
						modelService.createModel(
							body.text,
							languages.createByFilepathOrFirstLine(resource, body.text.split("\n", 1)[0]),
							resource,
						)
					);
					if (body.localPath) {
						this.followDisk(model, URI.file(body.localPath), async () => (await this.read<{ text: string }>(target.view.sessionId, "/file", { ...whiteboardSourceQuery(target.view), side: target.side, file: target.file })).text);
					}
					return model;
				},
			}),
		);
		this._register(models.registerTextModelContentProvider(WHITEBOARD_LANGUAGE_SOURCE_SCHEME, {
			provideTextContent: async resource => {
				const existing = modelService.getModel(resource);
				if (existing) return existing;
				const local = URI.file(resource.path);
				const read = async () => (await this.files.readFile(local)).value.toString();
				const model = modelService.createModel(await read(), languages.createByFilepathOrFirstLine(resource), resource);
				this.followDisk(model, local, read);
				return model;
			},
		}));
	}

	private followDisk(model: ITextModel, local: URI, read: () => Promise<string>): void {
		const owned = this._register(new DisposableStore());
		let revision = 0;
		owned.add(this.files.watch(local));
		owned.add(this.files.onDidFilesChange(event => {
			if (!event.affects(local)) return;
			const request = ++revision;
			void read().then(text => {
				if (!model.isDisposed() && request === revision && model.getValue() !== text) model.setValue(text);
			}).catch(() => { /* A missing file cannot supply fresh source. */ });
		}));
		owned.add(model.onWillDispose(() => { this._store.delete(owned); owned.dispose(); }));
	}

	private async read<T>(
		sessionId: string,
		route: string,
		query: Record<string, string | number | undefined>,
	): Promise<T> {
		const { serverUrl, token } = await this.session.getConnection();
		const params = new URLSearchParams(
			Object.entries(query)
				.filter(([key, value]) => key !== "sessionId" && value !== undefined)
				.map(([key, value]) => [key, String(value)]),
		);
		const response = await fetch(`${serverUrl}/sessions-api/${encodeURIComponent(sessionId)}${route}?${params}`, {
			headers: { "x-whiteboard-token": token },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw await whiteboardResponseError(response, `Could not read pinned source (${response.status}).`);
		// SAFETY: the route selects the response type; only the session metadata envelope changes.
		return await response.json() as T;
	}

	private async sourceResource(target: ApiSourceTarget, empty = false): Promise<URI> {
		return apiSourceUri(target, empty);
	}

	async open(target: ApiSourceTarget, range?: WhiteboardInlineEditorRange): Promise<void> {
		const pane = await this.editors.openEditor({
			resource: await this.sourceResource(target),
			options: {
				pinned: true,
				...(range
					? {
						selection: {
							startLineNumber: range.startLine,
							startColumn: 1,
							endLineNumber: range.endLine,
							endColumn: Number.MAX_SAFE_INTEGER,
						},
					}
					: {}),
			},
		});
		if (pane?.input) this.tabs.registerWhiteboardEditor(target.view.sessionId, pane.input);
	}

	async openDiff(view: WhiteboardSourceView, path: string): Promise<void> {
		const files = await this.read<WhiteboardDiffFileWire[]>(view.sessionId, "/diff", whiteboardSourceQuery(view));
		const file = files.find((file) => file.path === path);
		if (!file) throw new Error(`File is not changed in this review version: ${path}`);
		const target = { view, file: path };
		const pane = await this.editors.openEditor({
			original: {
				resource: await this.sourceResource({ ...target, file: file.previousPath ?? path, side: "base" }, file.status === "added"),
			},
			modified: { resource: await this.sourceResource({ ...target, side: "head" }, file.status === "deleted") },
			options: { pinned: true },
		});
		if (pane?.input) this.tabs.registerWhiteboardEditor(view.sessionId, pane.input);
	}

	async children(resource: URI): Promise<IFileStat[]> {
		const selection = resource.scheme === WHITEBOARD_API_TREE_SCHEME ? sourceTreeSelection(resource) : undefined;
		let target: ApiSourceTarget;
		if (selection) {
			const snapshot = await this.read<Parameters<typeof resolveWhiteboardSourceView>[0]>(selection.sessionId, "", {
				full: "true", version: selection.kind === "version" ? selection.version : undefined,
			});
			target = { view: resolveWhiteboardSourceView(snapshot), side: "head", file: resource.path.slice(1) };
		} else {
			target = sourceLocation(resource);
		}

		const entries = await this.read<SessionSourceEntry[]>(target.view.sessionId, "/tree", {
			...whiteboardSourceQuery(target.view), side: target.side, path: target.file,
		});
		return entries.map((entry) => ({
			resource: selection && entry.kind === "directory" ? sourceTreeUri(selection, entry.path) : apiSourceUri({ ...target, file: entry.path }),
			name: entry.path.split("/").at(-1)!,
			isFile: entry.kind === "file",
			isDirectory: entry.kind === "directory",
			isSymbolicLink: false,
			readonly: true,
			children: undefined,
		}));
	}

	canvas(view: () => WhiteboardSourceView, inline: WhiteboardEmbeddedEditors, diff: WhiteboardDiffViewService) {
		const comparisonGeneration = diff.comparisonGeneration;
		const lists = new Map<string, Promise<readonly WhiteboardDiffFileWire[]>>();
		const files = (current: WhiteboardSourceView) => {
			const key = JSON.stringify(whiteboardSourceQuery(current));
			let list = lists.get(key);
			if (!list) {
				list = this.read<WhiteboardDiffFileWire[]>(current.sessionId, "/diff", whiteboardSourceQuery(current));
				list.catch(() => lists.delete(key));
				lists.set(key, list);
			}
			return list;
		};
		const openComparison = (current: WhiteboardSourceView) => diff.openComparison(
			JSON.stringify(whiteboardSourceQuery(current)), new StructuralDiffClient(this.session, current), comparisonGeneration,
		);
		const makeSource = (getView: () => WhiteboardSourceView): WhiteboardDiffViewSource => ({
			files: scope => files(whiteboardSourceComparison(getView(), scope?.commit)),
			load: async (scope, lens) => {
				if (lens && (scope || lens.sessionId !== getView().sessionId)) throw new Error("A lens must use its session comparison.");
				// Capture the comparison once; live checkout bytes may change during the load.
				const current = whiteboardSourceComparison(getView(), scope?.commit);
				const comparisonFiles = await files(current);
				const entries = lens ? lensFiles(comparisonFiles, lens).filter(file => lens.ranges.some(range =>
					range.file === (range.side === "base" ? file.previousPath ?? file.path : file.path))) : orderWhiteboardDiffFiles(comparisonFiles);

				return {
					session: openComparison(current),
					sourceUri: URI.from({ scheme: "review-api-diff", authority: current.sessionId, path: `/${current.version}/${current.generation ?? ""}`, query: comparisonQuery(current) }),
					entries: await Promise.all(entries.map(async file => {
						const original = file.status === "added" ? undefined : await this.sourceResource({ view: current, side: "base", file: file.previousPath ?? file.path });
						const modified = file.status === "deleted" ? undefined : await this.sourceResource({ view: current, side: "head", file: file.path });
						return { file, original, modified, goToFileResource: (modified ?? original)! };
					})),
				};
			},
		});
		const diffSource = makeSource(view);
		const documentScope = (spec: WhiteboardInlineFindSpec) => {
			// A source with its own pins is read at them; the review comparison does not apply.
			const current = spec.pins ? whiteboardSourceAnchor(view(), spec.pins) : whiteboardSourceComparison(view());
			const lens: WhiteboardDiffLens = {
				id: "document:" + JSON.stringify([spec.path, spec.ranges, spec.pins]), title: spec.path,
				sessionId: current.sessionId, version: current.version,
				ranges: spec.ranges.map(range => ({ file: spec.path, side: range.side ?? spec.side, fromLine: range.startLine, toLine: range.endLine })),
			};
			return { lens, source: makeSource(() => current) };
		};
		return {
			openStructuralComparison: () => diff.structuralRenderingEnabled ? openComparison(whiteboardSourceComparison(view())) : undefined,
			inlineEditors: {
				create: (spec) => { const { lens, source } = documentScope(spec); return diff.createDocument(spec, lens, source); },
				find: async (spec, query) => { const { lens, source } = documentScope(spec); return { matchCount: (await diff.findDocument(lens, source, query)).length }; },
			} satisfies WhiteboardInlineEditorFactory,
			diffView: {
				create: (spec) => diff.create(spec, diffSource),
				files: diffSource.files,
			} satisfies WhiteboardDiffViewFactory,
		};
	}
}
