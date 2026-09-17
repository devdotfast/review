/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import type { IFileStat } from "../../platform/files/common/files.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IWorkspaceEditingService } from "../../workbench/services/workspaces/common/workspaceEditing.js";
import { ITextFileService } from "../../workbench/services/textfile/common/textfiles.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { reviewPeekWindows, reviewPeekDiffWindows, reviewPeekLineMappings } from "../common/reviewPeek.js";
import type {
	ReviewDiffSide,
	ReviewInlineEditorRange,
	ReviewDiffFileWire,
	ReviewInlineEditorFactory,
	ReviewDiffViewFactory,
	ReviewSourceEntry,
	ReviewApiSourceLocation,
} from "../common/reviewProtocol.js";
import { acquireReviewLanguageRoot } from "./reviewLocalWorkspace.js";
import { IReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";
import type { ReviewCodeModelReference, ReviewCodeDiffTarget } from "./reviewCodeResourceService.js";
import { IReviewDesktopConnectionService, reviewResponseError } from "./reviewDesktopConnectionService.js";
import type { ReviewDiffViewService, ReviewDiffViewSource } from "./reviewDiffViewService.js";
import type { ReviewInlineEditorService, ReviewInlineSource } from "./reviewInlineEditorService.js";

export interface ApiSourceTarget extends ReviewApiSourceLocation {
	reviewId: string;
}

export const REVIEW_API_SOURCE_SCHEME = "review-api-source";
export function apiSourceUri(target: ApiSourceTarget, empty = false): URI {
	const query = new URLSearchParams({ version: String(target.version), side: target.side });
	if (target.generation) query.set("generation", target.generation);
	if (target.live) query.set("live", "true");
	if (target.commit) query.set("commit", target.commit);
	if (empty) query.set("empty", "true");
	return URI.from({
		scheme: REVIEW_API_SOURCE_SCHEME,
		authority: target.reviewId,
		path: `/${target.file}`,
		query: query.toString(),
	});
}

export const IReviewApiSourceService = createDecorator<IReviewApiSourceService>("reviewApiSourceService");
export interface IReviewApiSourceService {
	readonly _serviceBrand: undefined;
	open(target: ApiSourceTarget, range?: ReviewInlineEditorRange): Promise<void>;
	children(resource: URI): Promise<IFileStat[]>;
	openDiff(reviewId: string, version: number, path: string, state?: { generation?: string; live?: boolean }): Promise<void>;
	canvas(
		reviewId: string,
		version: () => number,
		inline: ReviewInlineEditorService,
		diff: ReviewDiffViewService,
		sourceState?: () => { generation?: string; live?: boolean },
	): {
		inlineEditors: ReviewInlineEditorFactory;
		diffView: ReviewDiffViewFactory;
	};
}

/** Pinned, read-only native models. Only the desktop API reads repository files. */
export class ReviewApiSourceService extends Disposable implements IReviewApiSourceService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IReviewDesktopConnectionService private readonly session: IReviewDesktopConnectionService,
		@ITextModelService private readonly models: ITextModelService,
		@IModelService modelService: IModelService,
		@ILanguageService languages: ILanguageService,
		@IEditorService private readonly editors: IEditorService,
		@IReviewCanvasEditorTabsService private readonly tabs: IReviewCanvasEditorTabsService,
		@IWorkspaceEditingService private readonly workspace: IWorkspaceEditingService,
		@ITextFileService private readonly textFiles: ITextFileService,
	) {
		super();
		this._register(
			models.registerTextModelContentProvider(REVIEW_API_SOURCE_SCHEME, {
				provideTextContent: async (resource) => {
					const query = new URLSearchParams(resource.query);
					const target = {
						reviewId: resource.authority,
						version: Number(query.get("version")),
						generation: query.get("generation") ?? undefined,
						side: query.get("side") ?? "",
						file: resource.path.slice(1),
						commit: query.get("commit") ?? undefined,
					};
					const body = query.has("empty")
						? { text: "" }
						: await this.read<{ text: string }>(target.reviewId, "/file", target);
					return (
						modelService.getModel(resource) ??
						modelService.createModel(
							body.text,
							languages.createByFilepathOrFirstLine(resource, body.text.split("\n", 1)[0]),
							resource,
						)
					);
				},
			}),
		);
	}

	private async read<T>(
		reviewId: string,
		route: string,
		query: Record<string, string | number | undefined>,
	): Promise<T> {
		const { serverUrl, token } = await this.session.getConnection();
		const params = new URLSearchParams(
			Object.entries(query)
				.filter(([key, value]) => key !== "reviewId" && value !== undefined)
				.map(([key, value]) => [key, String(value)]),
		);
		const response = await fetch(`${serverUrl}/reviews-api/${encodeURIComponent(reviewId)}${route}?${params}`, {
			headers: { "x-review-token": token },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw await reviewResponseError(response, `Could not read pinned source (${response.status}).`);
		return response.json();
	}

	private readonly localRoots = new Map<string, Promise<void>>();
	private async sourceResource(target: ApiSourceTarget, empty = false): Promise<URI> {
		if (!empty && target.live && target.side === "head" && !target.commit) {
			const file = await this.read<{ localPath?: string; localRoot?: string }>(target.reviewId, "/file", { version: target.version, generation: target.generation, file: target.file, side: target.side, live: "true" });
			if (file.localPath && file.localRoot) {
				const resource = URI.file(file.localPath);
				if (!this.textFiles.isDirty(resource)) {
					let acquired = this.localRoots.get(file.localRoot);
					if (!acquired) {
						acquired = acquireReviewLanguageRoot(this.workspace, URI.file(file.localRoot)).then(root => { this._register(root); });
						this.localRoots.set(file.localRoot, acquired);
						acquired.catch(() => this.localRoots.delete(file.localRoot!));
					}
					await acquired;
					return resource;
				}
			}
		}
		return apiSourceUri(target, empty);
	}

	async open(target: ApiSourceTarget, range?: ReviewInlineEditorRange): Promise<void> {
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
		if (pane?.input) this.tabs.registerReviewEditor(target.reviewId, pane.input);
	}

	async openDiff(reviewId: string, version: number, path: string, state?: { generation?: string; live?: boolean }): Promise<void> {
		const files = await this.read<ReviewDiffFileWire[]>(reviewId, "/diff", { version, generation: state?.generation });
		const file = files.find((file) => file.path === path);
		if (!file) throw new Error(`File is not changed in this review version: ${path}`);
		const target = { reviewId, version, file: path, ...state };
		const pane = await this.editors.openEditor({
			original: {
				resource: await this.sourceResource({ ...target, file: file.previousPath ?? path, side: "base" }, file.status === "added"),
			},
			modified: { resource: await this.sourceResource({ ...target, side: "head" }, file.status === "deleted") },
			options: { pinned: true },
		});
		if (pane?.input) this.tabs.registerReviewEditor(reviewId, pane.input);
	}

	async children(resource: URI): Promise<IFileStat[]> {
		const query = new URLSearchParams(resource.query);
		const state = query.has("live") ? await this.read<{ version: number; pins: { sourceGeneration?: string } }>(resource.authority, "", { full: "true" }) : undefined;
		if (state) {
			query.set("version", String(state.version));
			if (state.pins.sourceGeneration) query.set("generation", state.pins.sourceGeneration);
		}
		const entries = await this.read<ReviewSourceEntry[]>(resource.authority, "/tree", {
			version: Number(query.get("version")),
			generation: query.get("generation") ?? undefined,
			side: query.get("side") ?? "head",
			path: resource.path.slice(1),
			commit: query.get("commit") ?? undefined,
		});
		return entries.map((entry) => ({
			resource: resource.with({ path: `/${entry.path}`, query: query.toString() }),
			name: entry.path.split("/").at(-1)!,
			isFile: entry.kind === "file",
			isDirectory: entry.kind === "directory",
			isSymbolicLink: false,
			readonly: true,
			children: undefined,
		}));
	}

	private async snippet(
		target: ApiSourceTarget,
		ranges: readonly ReviewInlineEditorRange[],
	): Promise<ReviewCodeModelReference> {
		const resource = await this.sourceResource(target);
		const reference = await this.models.createModelReference(resource);
		try {
			const model = reference.object.textEditorModel;
			return {
				model,
				target: { resource },
				windows: reviewPeekWindows(model.getLineCount(), ranges, "content"),
				dispose: () => reference.dispose(),
			};
		} catch (error) {
			reference.dispose();
			throw error;
		}
	}

	private async peekDiff(
		target: ApiSourceTarget,
		ranges: readonly ReviewInlineEditorRange[],
		files: Promise<readonly ReviewDiffFileWire[]>,
	): Promise<ReviewCodeDiffTarget | undefined> {
		const file = (await files).find(
			(file) => (target.side === "base" ? (file.previousPath ?? file.path) : file.path) === target.file,
		);
		if (!file) return undefined;
		// Mappings come from the patch, as in the session path; the editors own the models.
		const patch =
			file.patch ??
			(await this.read<string>(target.reviewId, "/diff", {
				version: target.version,
				generation: target.generation,
				commit: target.commit,
				file: file.path,
			}));
		const mappings = reviewPeekLineMappings(patch);
		return {
			original: await this.sourceResource(
				{ ...target, side: "base", file: file.previousPath ?? file.path },
				file.status === "added",
			),
			modified: await this.sourceResource({ ...target, side: "head", file: file.path }, file.status === "deleted"),
			diffFile: file,
			mappings,
			windows: (leftCount, rightCount) => reviewPeekDiffWindows(leftCount, rightCount, ranges, target.side, mappings),
		};
	}

	canvas(reviewId: string, version: () => number, inline: ReviewInlineEditorService, diff: ReviewDiffViewService, sourceState: () => { generation?: string; live?: boolean } = () => ({})) {
		// A version's diff list is immutable: every peek and the diff view share one read.
		const lists = new Map<string, Promise<readonly ReviewDiffFileWire[]>>();
		const files = (current: number, commit?: string, generation = sourceState().generation) => {
			const key = `${current}:${generation ?? ""}:${commit ?? ""}`;
			let list = lists.get(key);
			if (!list) {
				list = this.read<ReviewDiffFileWire[]>(reviewId, "/diff", { version: current, generation, commit });
				list.catch(() => lists.delete(key));
				lists.set(key, list);
			}
			return list;
		};
		const source = (
			file: string,
			side: ReviewDiffSide,
			ranges: readonly ReviewInlineEditorRange[],
		): ReviewInlineSource => {
			const target: ApiSourceTarget = { reviewId, version: version(), file, side, ...sourceState() };
			return {
				snippet: () => this.snippet(target, ranges),
				diff: () => this.peekDiff(target, ranges, files(target.version, target.commit, target.generation)),
			};
		};
		const diffSource: ReviewDiffViewSource = {
			files: (scope) => files(version(), scope?.commit),
			load: async (scope) => {
				// Capture before awaiting: a live edit must not mix two versions' pins.
				const current = version();
				const state = sourceState();
				const commit = scope?.commit;
				const entries = await files(current, commit);
				return {
					sourceUri: URI.from({
						scheme: "review-api-diff",
						authority: reviewId,
						path: `/${current}/${state.generation ?? ""}`,
						query: commit ? `commit=${encodeURIComponent(commit)}` : undefined,
					}),
					entries: await Promise.all(entries.map(async (file) => {
						const original =
							file.status === "added"
								? undefined
								: await this.sourceResource({
									reviewId,
									version: current,
									...state,
									side: "base",
									file: file.previousPath ?? file.path,
									commit,
								});
						const modified =
							file.status === "deleted"
								? undefined
								: await this.sourceResource({
									reviewId,
									version: current,
									...state,
									side: "head",
									file: file.path,
									commit,
								});
						return { file, original, modified, goToFileResource: (modified ?? original)! };
					})),
				};
			},
		};
		return {
			inlineEditors: {
				create: (spec) => inline.create(spec, source(spec.path, spec.side, spec.ranges)),
				find: (spec, query) => inline.find(spec, query, source(spec.path, spec.side, spec.ranges)),
			} satisfies ReviewInlineEditorFactory,
			diffView: {
				create: (spec) => diff.create(spec, diffSource),
				files: diffSource.files,
			} satisfies ReviewDiffViewFactory,
		};
	}
}
