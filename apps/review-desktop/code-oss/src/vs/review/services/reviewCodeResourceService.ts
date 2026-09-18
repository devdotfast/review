/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IReference } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import type { ITextModel } from "../../editor/common/model.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService, type IResolvedTextEditorModel } from "../../editor/common/services/resolverService.js";
import { FileOperationError, FileOperationResult } from "../../platform/files/common/files.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { REVIEW_UNIFIED_SCHEME } from "../common/reviewCodeResources.js";
import { type ReviewPeekLineMapping, type ReviewPeekWindow } from "../common/reviewPeek.js";
import type { ReviewDiffFileWire, ReviewDiffSide, ReviewInlineEditorRange } from "../common/reviewProtocol.js";
import {
	buildReviewUnifiedDiff,
	reviewUnifiedRangesForSelections,
	reviewUnifiedTargetForRange,
	reviewUnifiedWindows,
	type ReviewUnifiedDiffRow,
	type ReviewUnifiedLineRange,
} from "../common/reviewUnifiedDiff.js";
export interface ReviewCodeResourceTarget {
	readonly resource: URI;
	readonly diffFile?: ReviewDiffFileWire;
}

export interface ReviewCodeModelReference {
	readonly model: ITextModel;
	readonly target: ReviewCodeResourceTarget;
	readonly windows: readonly ReviewPeekWindow[];
	dispose(): void;
}

export interface ReviewCodeDiffTarget {
	readonly original: URI;
	readonly modified: URI;
	readonly diffFile: ReviewDiffFileWire;
	readonly mappings: readonly ReviewPeekLineMapping[];
	windows(
		originalLineCount: number,
		modifiedLineCount: number,
	): {
		readonly original: readonly ReviewPeekWindow[];
		readonly modified: readonly ReviewPeekWindow[];
	};
}

export interface ReviewUnifiedResourceInfo {
	readonly original: URI;
	readonly modified: URI;
	readonly path: string;
	readonly diffFile: ReviewDiffFileWire;
	readonly rows: readonly ReviewUnifiedDiffRow[];
	targetForRange(
		startLine: number,
		endLine: number,
	): {
		readonly path: string;
		readonly side: ReviewDiffSide;
		readonly startLine: number;
		readonly endLine: number;
	} | null;
}

export interface ReviewUnifiedCodeModelReference {
	readonly model: ITextModel;
	readonly target: ReviewCodeDiffTarget;
	readonly rows: readonly ReviewUnifiedDiffRow[];
	readonly windows: readonly ReviewPeekWindow[];
	readonly ranges: readonly ReviewUnifiedLineRange[];
	dispose(): void;
}

interface ReviewUnifiedResourceEntry {
	readonly model: ITextModel;
	readonly info: ReviewUnifiedResourceInfo;
	readonly rows: readonly ReviewUnifiedDiffRow[];
	readonly originalLineCount: number;
	readonly modifiedLineCount: number;
	references: number;
	dispose(): void;
}

export const IReviewCodeResourceService = createDecorator<IReviewCodeResourceService>("reviewCodeResourceService");

export interface IReviewCodeResourceService {
	readonly _serviceBrand: undefined;
	/** The unified view of a target the caller resolved, such as pinned API models. */
	acquireUnifiedDiffForTarget(
		path: string,
		side: ReviewDiffSide,
		ranges: readonly ReviewInlineEditorRange[],
		target: ReviewCodeDiffTarget,
	): Promise<ReviewUnifiedCodeModelReference | undefined>;
	unifiedResource(resource: URI): ReviewUnifiedResourceInfo | undefined;
	reset(): void;
}

export class ReviewCodeResourceService extends Disposable implements IReviewCodeResourceService {
	declare readonly _serviceBrand: undefined;
	private generation = 0;
	private readonly unifiedResources = new Map<string, ReviewUnifiedResourceEntry>();
	private readonly unifiedResourcesInFlight = new Map<string, Promise<ReviewUnifiedResourceEntry>>();

	constructor(
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(
			textModelService.registerTextModelContentProvider(REVIEW_UNIFIED_SCHEME, {
				provideTextContent: (resource) => Promise.resolve(this.modelService.getModel(resource)),
			}),
		);
	}

	async acquireUnifiedDiffForTarget(
		path: string,
		side: ReviewDiffSide,
		ranges: readonly ReviewInlineEditorRange[],
		target: ReviewCodeDiffTarget,
	): Promise<ReviewUnifiedCodeModelReference | undefined> {
		// Pinned sides identify the content; no session is involved.
		const query = new URLSearchParams({
			path,
			side,
			original: target.original.toString(),
			modified: target.modified.toString(),
		});
		return this.acquireUnifiedFor(path, side, ranges, target, query);
	}

	private async acquireUnifiedFor(
		path: string,
		side: ReviewDiffSide,
		ranges: readonly ReviewInlineEditorRange[],
		target: ReviewCodeDiffTarget,
		query: URLSearchParams,
	): Promise<ReviewUnifiedCodeModelReference | undefined> {
		const generation = this.generation;
		const resource = URI.from({
			scheme: REVIEW_UNIFIED_SCHEME,
			path: `/${path}`,
			query: query.toString(),
		});
		const key = resource.toString();
		let entry = this.unifiedResources.get(key);
		if (!entry) {
			let pending = this.unifiedResourcesInFlight.get(key);
			if (!pending) {
				pending = this.createUnifiedResource(path, side, resource, target);
				this.unifiedResourcesInFlight.set(key, pending);
				const clearPending = () => {
					if (this.unifiedResourcesInFlight.get(key) === pending) {
						this.unifiedResourcesInFlight.delete(key);
					}
				};
				void pending.then(clearPending, clearPending);
			}
			entry = await pending;
			if (generation !== this.generation) {
				entry.dispose();
				return undefined;
			}
			this.unifiedResources.set(key, entry);
		}
		entry.references += 1;
		const diffWindows = target.windows(entry.originalLineCount, entry.modifiedLineCount);
		let disposed = false;
		return {
			model: entry.model,
			target,
			rows: entry.rows,
			windows: reviewUnifiedWindows(entry.rows, diffWindows.original, diffWindows.modified),
			ranges: reviewUnifiedRangesForSelections(entry.rows, ranges, side),
			dispose: () => {
				if (disposed) return;
				disposed = true;
				entry.references -= 1;
				if (entry.references > 0) return;
				if (this.unifiedResources.get(key) === entry) {
					this.unifiedResources.delete(key);
				}
				entry.dispose();
			},
		};
	}

	unifiedResource(resource: URI): ReviewUnifiedResourceInfo | undefined {
		return this.unifiedResources.get(resource.toString())?.info;
	}

	reset(): void {
		for (const entry of this.unifiedResources.values()) entry.dispose();
		this.unifiedResources.clear();
		this.unifiedResourcesInFlight.clear();
		this.generation += 1;
	}

	private async createUnifiedResource(
		path: string,
		side: ReviewDiffSide,
		resource: URI,
		target: ReviewCodeDiffTarget,
	): Promise<ReviewUnifiedResourceEntry> {
		const [original, modified] = await Promise.allSettled([
			this.textModelService.createModelReference(target.original),
			this.textModelService.createModelReference(target.modified),
		]);
		// A missing side must also release the other side, even if that reference
		// finishes loading after the failure. Preserve the resolver's error.
		if (original.status === "rejected") {
			if (modified.status === "fulfilled") modified.value.dispose();
			// A missing base must not hide an unexpected failure on the head.
			if (
				modified.status === "rejected" &&
				original.reason instanceof FileOperationError &&
				original.reason.fileOperationResult === FileOperationResult.FILE_NOT_FOUND
			) {
				throw modified.reason;
			}
			throw original.reason;
		}
		if (modified.status === "rejected") {
			original.value.dispose();
			throw modified.reason;
		}
		const originalReference = original.value;
		const modifiedReference = modified.value;
		const originalModel = originalReference.object.textEditorModel;
		const modifiedModel = modifiedReference.object.textEditorModel;
		if (!originalModel || !modifiedModel) {
			originalReference.dispose();
			modifiedReference.dispose();
			throw new Error(`Unified preview could not resolve text content: ${path}`);
		}

		const baseLines = target.diffFile.status === "added" ? [] : originalModel.getLinesContent();
		const headLines = target.diffFile.status === "deleted" ? [] : modifiedModel.getLinesContent();
		const unified = buildReviewUnifiedDiff(baseLines, headLines, target.mappings, side);
		const sourceModel = target.diffFile.status === "deleted" ? originalModel : modifiedModel;
		let model: ITextModel;
		try {
			model = this.modelService.createModel(
				unified.content,
				this.languageService.createById(sourceModel.getLanguageId()),
				resource,
			);
		} catch (error) {
			originalReference.dispose();
			modifiedReference.dispose();
			throw error;
		}
		// The side model takes its language only once its checkout is a workspace folder
		// (reviewLocalLanguageFeatures.ts); the unified preview follows it.
		const followLanguage = sourceModel.onDidChangeLanguage(event => model.setLanguage(event.newLanguage));
		let resolverReference: IReference<IResolvedTextEditorModel>;
		try {
			// References and Peek Definition resolve this resource independently.
			// Keep one resolver owner until the inline CodePeek releases the model.
			resolverReference = await this.textModelService.createModelReference(resource);
		} catch (error) {
			followLanguage.dispose();
			model.dispose();
			originalReference.dispose();
			modifiedReference.dispose();
			throw error;
		}
		let disposed = false;
		return {
			model,
			rows: unified.rows,
			originalLineCount: originalModel.getLineCount(),
			modifiedLineCount: modifiedModel.getLineCount(),
			references: 0,
			info: {
				original: target.original,
				modified: target.modified,
				path,
				diffFile: target.diffFile,
				rows: unified.rows,
				targetForRange: (startLine, endLine) => reviewUnifiedTargetForRange(path, unified.rows, startLine, endLine),
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				followLanguage.dispose();
				resolverReference.dispose();
				originalReference.dispose();
				modifiedReference.dispose();
			},
		};
	}
}
