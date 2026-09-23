import type { IDocumentDiffProvider, IDocumentDiff } from "../../editor/common/diff/documentDiffProvider.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StructuralDiffSession } from "./reviewStructuralDiffSession.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { URI } from "../../base/common/uri.js";
import { Event } from "../../base/common/event.js";
import { DisposableStore } from "../../base/common/lifecycle.js";
import { CancellationError } from "../../base/common/errors.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from "../../platform/instantiation/common/serviceCollection.js";
import { IDiffProviderFactoryService } from "../../editor/browser/widget/diffEditor/diffProviderFactoryService.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import type { IDiffEditor } from "../../editor/browser/editorBrowser.js";
import { LineRange } from "../../editor/common/core/ranges/lineRange.js";
import { DetailedLineRangeMapping } from "../../editor/common/diff/rangeMapping.js";
import { autorun, derived, type IObservable } from "../../base/common/observable.js";
import type { UnchangedRegion } from "../../editor/browser/widget/diffEditor/diffEditorViewModel.js";
import {
	structuralContextGaps,
	structuralContextScopes,
	structuralRows,
	structuralHighlights,
} from "../common/reviewStructuralDiff.js";
import type { ReviewFilesEditorEntry } from "./reviewFilesDiffView.js";

/** View-owned Monaco providers and editor listeners; comparison state lives in session. */
export function createStructuralDiffEditors(
	instantiation: IInstantiationService,
	entries: readonly ReviewFilesEditorEntry[],
	lifetime: DisposableStore,
	session: StructuralDiffSession,
): { instantiation: IInstantiationService; entries: readonly ReviewFilesEditorEntry[] } {
	// Use pinned checkout resources so native language providers see real project files.
	// Revision-only resources retain their virtual snapshot identity.
	const modelService = instantiation.invokeFunction((a) => a.get(IModelService));
	const resolver = instantiation.invokeFunction((a) => a.get(ITextModelService));
	lifetime.add(resolver.registerTextModelContentProvider("review-structural-empty", {
		provideTextContent: async uri => modelService.getModel(uri) ?? modelService.createModel("", null, uri),
	}));
	const resolvedEntries = entries.map(entry => ({
		...entry,
		original: entry.original ?? URI.from({ scheme: "review-structural-empty", path: "/base/" + entry.file.path, query: entry.modified!.toString() }),
		modified: entry.modified ?? URI.from({ scheme: "review-structural-empty", path: "/head/" + entry.file.path, query: entry.original!.toString() }),
	}));
	const unchanged = new Set(entries.filter(e => e.file.status === "unchanged").map(e => e.file.path));
	const pairs = new Map(resolvedEntries.map(e => [e.original!.toString() + "\n" + e.modified!.toString(), e.file.path]));
	const factory: IDiffProviderFactoryService = {
		_serviceBrand: undefined,
		createDiffProvider: () => new StructuralDiffProvider(session, pairs, unchanged),
	};
	const child = lifetime.add(
		instantiation.createChild(new ServiceCollection([IDiffProviderFactoryService, factory])),
	);
	attachStructuralEditors(instantiation, resolvedEntries, session, lifetime);
	return { instantiation: child, entries: resolvedEntries };
}

/** Adapts session snapshots and fold state to Monaco's diff interface. */
export class StructuralDiffProvider implements IDocumentDiffProvider {
	private path: string | undefined;
	readonly onDidChange: Event<void>;
	constructor(private readonly session: StructuralDiffSession, private readonly pairs: ReadonlyMap<string, string>, private readonly unchanged: ReadonlySet<string>) {
		this.onDidChange = Event.map(Event.filter(session.onDidChange, change => this.path !== undefined && change.files.has(this.path)), () => undefined);
	}
	async computeDiff(...[original, modified, _options, token]: Parameters<IDocumentDiffProvider["computeDiff"]>): Promise<IDocumentDiff> {
		if (token.isCancellationRequested) throw new CancellationError();
		const path = this.pairs.get(original.uri.with({ fragment: "" }).toString() + "\n" + modified.uri.with({ fragment: "" }).toString());
		this.path = path;
		if (path !== undefined && this.unchanged.has(path)) {
			if (original.getValue() !== modified.getValue()) throw new Error("Referenced context file changed; reload the session.");
			return { changes: [], moves: [], identical: true, quitEarly: false };
		}
		if (path !== undefined && this.session.getFileResult(path)?.diff?.type === "binary") {
			return { changes: [], moves: [], identical: false, quitEarly: false, changeHighlights: { original: [], modified: [] } };
		}
		const diff = path === undefined ? undefined : this.session.getTextDiff(path);
		if (!diff) throw new Error("diffr did not supply a result for this file.");
		const left = (diff.lhs?.text ?? "").replace(/\r\n/g, "\n");
		const right = (diff.rhs?.text ?? "").replace(/\r\n/g, "\n");
		if (
			original.getLinesContent().join("\n") !== left ||
			modified.getLinesContent().join("\n") !== right
		) {
			throw new Error(
				"diffr sources differ from Whiteboard's editor snapshots; reload the session.",
			);
		}
		const rows = structuralRows(diff);
		// Changed-ness comes from the wire: a one-sided row, or a paired row whose line carries a changed span.
		const highlights = structuralHighlights(diff);
		const changedLeft = new Set(highlights.originalLines), changedRight = new Set(highlights.modifiedLines);
		const changes: DetailedLineRangeMapping[] = [];
		let l = 0,
			r = 0;
		let start: [number, number] | undefined;
		const flush = () => {
			if (start)
				changes.push(
					new DetailedLineRangeMapping(
						new LineRange(start[0] + 1, l + 1),
						new LineRange(start[1] + 1, r + 1),
						undefined,
					),
				);
			start = undefined;
		};
		for (const [a, b] of rows) {
			const changed = a === null || b === null || changedLeft.has(a + 1) || changedRight.has(b + 1);
			if (changed) start ??= [l, r];
			else flush();
			if (a !== null) l = a + 1;
			if (b !== null) r = b + 1;
		}
		flush();
		return {
			changes,
			moves: [],
			identical: left === right,
			quitEarly: false,
			sourceLineAlignment: rows,
			contextScopes: structuralContextScopes(diff),
			// Every collapsed region is a hidden-region band, labelled by the wire.
			contextGaps: structuralContextGaps(
				diff,
				(id) => this.session.isRegionCollapsed(path!, id) === true,
				(id) => this.session.isRegionCollapsed(path!, id),
			).map(gap => ({
				...gap, labelObservable: derived(reader => {
					for (const id of gap.regionIds) {
						const label = this.session.regionLabel(path!, id).read(reader);
						if (label) return label;
					}
					const count = Math.max(gap.originalCount, gap.modifiedCount);
					return `${count} hidden line${count === 1 ? "" : "s"}`;
				})
			})),
			changeHighlights: highlights,
		};
	}
}

/**
 * Keeps each structural diff editor's bands in step with the collapse state:
 * a band a reader reveals (its arrows, or double-click) marks its fold state
 * open, which covers both sides by construction, and the visible counts follow.
 */
function attachStructuralEditors(
	instantiation: IInstantiationService,
	entries: readonly ReviewFilesEditorEntry[],
	session: StructuralDiffSession,
	lifetime: DisposableStore,
): void {
	const editors = instantiation.invokeFunction((a) => a.get(ICodeEditorService));
	const pairs = new Map(entries.map((e) => [e.original!.toString() + "\n" + e.modified!.toString(), e.file.path]));
	function watch(editor: IDiffEditor) {
		const store = lifetime.add(new DisposableStore());
		store.add(editor.onDidDispose(() => store.dispose()));
		const widget = editor as unknown as { unchangedRegions?: IObservable<readonly UnchangedRegion[]> };
		if (!widget.unchangedRegions) return;
		let revealed = new Set<UnchangedRegion>();
		store.add(
			autorun((reader) => {
				const model = editor.getModel();
				const path = model && pairs.get(model.original.uri.with({ fragment: "" }).toString() + "\n" + model.modified.uri.with({ fragment: "" }).toString());
				const regions = widget.unchangedRegions!.read(reader);
				if (!path || !session.getTextDiff(path)) return;
				const gaps = structuralContextGaps(session.getTextDiff(path)!, (id) => session.isRegionCollapsed(path, id) === true, (id) => session.isRegionCollapsed(path, id));
				const next = new Set<UnchangedRegion>();
				const gapOf = (region: UnchangedRegion) =>
					gaps.find((g) => g.originalStart === region.originalLineNumber && g.modifiedStart === region.modifiedLineNumber && g.foldStateId === region.foldStateId);
				for (const region of regions) {
					const fullyShown = region.visibleLineCountTop.read(reader) + region.visibleLineCountBottom.read(reader) >= region.lineCount;
					if (fullyShown) {
						next.add(region);
						if (revealed.has(region)) continue;
						const gap = gapOf(region);
						if (!gap) continue;
						session.setRegionCollapsed(path, gap.foldStateId, false);
					} else if (revealed.has(region)) {
						// Monaco's own fold control closed a region we had marked open.
						const gap = gapOf(region);
						if (!gap) continue;
						session.setRegionCollapsed(path, gap.foldStateId, true);
					}
				}
				revealed = next;
			}),
		);
	}

	lifetime.add(editors.onDiffEditorAdd(watch));
	for (const editor of editors.listDiffEditors()) watch(editor);
}

