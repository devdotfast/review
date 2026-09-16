/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { URI } from "../../base/common/uri.js";
import { Emitter, Event } from "../../base/common/event.js";
import { DisposableStore, toDisposable } from "../../base/common/lifecycle.js";
import { CancellationError } from "../../base/common/errors.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from "../../platform/instantiation/common/serviceCollection.js";
import { IDiffProviderFactoryService } from "../../editor/browser/widget/diffEditor/diffProviderFactoryService.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import type { IDiffEditor } from "../../editor/browser/editorBrowser.js";
import { LineRange } from "../../editor/common/core/ranges/lineRange.js";
import { DetailedLineRangeMapping } from "../../editor/common/diff/rangeMapping.js";
import { autorun, type IObservable } from "../../base/common/observable.js";
import type { UnchangedRegion } from "../../editor/browser/widget/diffEditor/diffEditorViewModel.js";
import {
  structuralContextGaps,
  structuralFilePath,
  structuralInitialCounts,
  structuralRows,
  structuralHighlights,
  STRUCTURAL_WIRE_VERSION,
  type StructuralEvent,
  type StructuralFileCounts,
  type StructuralLineCounts,
  type StructuralRegion,
  type StructuralSource,
  type StructuralTextDiff,
} from "../common/reviewStructuralDiff.js";
import type { ReviewFilesEditorEntry } from "./reviewFilesDiffView.js";

/** What the stream says about one file once its result arrives. */
export interface StructuralFileOutcome {
  error?: string;
  stats?: StructuralLineCounts;
  /** The reason label when a plugin hid the whole file. */
  hidden?: string;
}

/** Owned by one Files view, including provider registrations and fold listeners. */
export async function prepareStructuralReview(
  instantiation: IInstantiationService,
  entries: readonly ReviewFilesEditorEntry[],
  lifetime: DisposableStore,
  request: (signal: AbortSignal) => Promise<Response>,
): Promise<{
  instantiation: IInstantiationService;
  enabled: boolean;
  entries: readonly ReviewFilesEditorEntry[];
  load(
    onFile: (path: string, outcome: StructuralFileOutcome) => void,
  ): Promise<void>;
  /** Fires when a file's visible counts change: on arrival and on every fold toggle. */
  onDidChangeCounts: Event<{ path: string; counts: StructuralFileCounts }>;
}> {
  const files = new Map<string, StructuralTextDiff>();
  const binary = new Set<string>();
  /** Collapse state by `${path}:${fold_state_id}`, seeded from the wire's initial visibility. A fold-state id spans sides. */
  const collapsed = new Map<string, boolean>();
  const collapseKey = (path: string, foldStateId: number) => `${path}:${foldStateId}`;
  const countsChanged = lifetime.add(new Emitter<{ path: string; counts: StructuralFileCounts }>());
  // Counts are the wire's, read once when a file arrives; folding never changes them.
  const emitCounts = (path: string) => {
    const diff = files.get(path);
    if (!diff) return;
    countsChanged.fire({ path, counts: structuralInitialCounts(diff) });
  };
  // Use pinned checkout resources so native language providers see real project files.
  // Revision-only resources retain their virtual snapshot identity.
  const modelService = instantiation.invokeFunction((a) => a.get(IModelService));
  const resolver = instantiation.invokeFunction((a) => a.get(ITextModelService));
  const languages = instantiation.invokeFunction((a) => a.get(ILanguageService));
  lifetime.add(resolver.registerTextModelContentProvider("review-structural-empty", {
    provideTextContent: async uri => modelService.getModel(uri) ?? modelService.createModel("", null, uri),
  }));
  const resolvedEntries = entries.map(entry => ({
    ...entry,
    original: entry.original ?? URI.from({ scheme: "review-structural-empty", path: "/base/" + entry.file.path, query: entry.modified!.toString() }),
    modified: entry.modified ?? URI.from({ scheme: "review-structural-empty", path: "/head/" + entry.file.path, query: entry.original!.toString() }),
  }));
  const pairs = new Map(resolvedEntries.map(e => [e.original!.toString() + "\n" + e.modified!.toString(), e.file.path]));
  async function accept(event: Extract<StructuralEvent, { type: "file" }>): Promise<{ path: string; stats?: StructuralLineCounts }> {
    const path = structuralFilePath(event.file);
    const entry = resolvedEntries.find(e => e.file.path === path);
    if (!entry) throw new Error(`diffr returned an unexpected file: ${path}`);
    if (event.error) throw new Error(event.error.message);
    const diff = event.diff!;
    if (diff.type === "text") {
      const sides: [typeof entry.original, StructuralSource | undefined][] = [
        [entry.original, diff.lhs],
        [entry.modified, diff.rhs],
      ];
      for (const [uri, source] of sides) {
        const text = source?.text ?? "";
        if (uri.scheme !== "file" && !modelService.getModel(uri))
          modelService.createModel(text, languages.createByFilepathOrFirstLine(uri), uri);
        const reference = lifetime.add(await resolver.createModelReference(uri));
        if (reference.object.textEditorModel.getValue().replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n"))
          throw new Error("Pinned checkout differs from diffr's source snapshot; reload the review.");
      }
    }
    if (lifetime.isDisposed) throw new CancellationError();
    if (diff.type === "text") {
      structuralInitialCounts(diff);
      files.set(path, diff);
      for (const source of [diff.lhs, diff.rhs]) {
        const seed = (region: StructuralRegion) => {
          const key = collapseKey(path, region.fold_state_id);
          if (!collapsed.has(key)) collapsed.set(key, region.visibility?.collapsed === true);
          if (region.kind === "fold") region.children.forEach(seed);
        };
        (source?.regions ?? []).forEach(seed);
      }
    } else binary.add(path);
    emitCounts(path);
    return { path, stats: diff.type === "text" ? diff.stats.textual : undefined };
  }
  async function load(
    onFile: (path: string, outcome: StructuralFileOutcome) => void,
  ): Promise<void> {
    const abort = new AbortController();
    lifetime.add(toDisposable(() => abort.abort()));
    const response = await request(abort.signal);
    if (!response.ok) throw new Error((await response.json()).error ?? "Structural diff request failed.");
    if (!response.body || !response.headers.get("content-type")?.includes("ndjson"))
      throw new Error("The Review host must be updated to stream structural diffs.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", started = false, complete = false;
    const seen = new Set<string>();
    async function line(text: string) {
      if (!text.trim()) return;
      const event = JSON.parse(text) as StructuralEvent | { type: "error"; message: string };
      if (!started) {
        if (event.type === "error") throw new Error(event.message);
        if (event.type !== "start" || event.version !== STRUCTURAL_WIRE_VERSION) throw new Error("Unsupported diffr stream protocol.");
        started = true;
      } else if (event.type === "file") {
        const path = structuralFilePath(event.file);
        seen.add(path);
        try {
          const accepted = await accept(event);
          onFile(accepted.path, {
            stats: accepted.stats,
            hidden: event.visibility?.collapsed ? event.visibility.label || "Hidden by default" : undefined,
          });
        } catch (error) {
          if (lifetime.isDisposed) throw error;
          onFile(path, { error: error instanceof Error ? error.message : String(error) });
        }
      } else if (event.type === "complete") {
        complete = true;
        if (event.aborted) throw new Error(`diffr stopped early: ${event.aborted.message}`);
      } else throw new Error((event as { message?: string }).message ?? `Unexpected diffr event: ${event.type}`);
    }
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const text = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          await line(text);
        }
        if (chunk.done) break;
      }
      await line(buffer);
      if (!complete) throw new Error("diffr stream ended before completion.");
      for (const entry of entries) if (!seen.has(entry.file.path))
        onFile(entry.file.path, { error: "diffr did not supply a result for this file." });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      abort.abort();
    }
  }
  /** Fires when collapse state changes, so every diff editor recomputes its bands. */
  const providerChanged = lifetime.add(new Emitter<void>());
  const factory: IDiffProviderFactoryService = {
    _serviceBrand: undefined,
    createDiffProvider() {
      return {
        onDidChange: providerChanged.event,
        async computeDiff(original, modified, _options, token) {
          if (token.isCancellationRequested) throw new CancellationError();
          const path = pairs.get(original.uri.toString() + "\n" + modified.uri.toString());
          if (path !== undefined && binary.has(path)) {
            return { changes: [], moves: [], identical: false, quitEarly: false, changeHighlights: { original: [], modified: [] } };
          }
          const diff = path === undefined ? undefined : files.get(path);
          if (!diff) throw new Error("diffr did not supply a result for this file.");
          const left = (diff.lhs?.text ?? "").replace(/\r\n/g, "\n");
          const right = (diff.rhs?.text ?? "").replace(/\r\n/g, "\n");
          if (
            original.getLinesContent().join("\n") !== left ||
            modified.getLinesContent().join("\n") !== right
          ) {
            throw new Error(
              "diffr sources differ from Review's editor snapshots; reload the review.",
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
            // Every collapsed region is a hidden-region band, labelled by the wire.
            contextGaps: structuralContextGaps(
              diff,
              (id) => collapsed.get(collapseKey(path!, id)) === true,
              (id) => collapsed.get(collapseKey(path!, id)),
            ),
            changeHighlights: highlights,
          };
        },
      };
    },
  };
  const child = lifetime.add(
    instantiation.createChild(new ServiceCollection([IDiffProviderFactoryService, factory])),
  );
  attachStructuralEditors(instantiation, resolvedEntries, files, lifetime, {
    get: (path, id) => collapsed.get(collapseKey(path, id)),
    set: (path, id, value) => {
      if (collapsed.get(collapseKey(path, id)) === value) return;
      collapsed.set(collapseKey(path, id), value);
      providerChanged.fire();
    },
  });
  return { instantiation: child, enabled: true, entries: resolvedEntries, load, onDidChangeCounts: countsChanged.event };
}

/**
 * Keeps each structural diff editor's bands in step with the collapse state:
 * a band a reader reveals (its arrows, or double-click) marks its fold state
 * open, which covers both sides by construction, and the visible counts follow.
 */
function attachStructuralEditors(
  instantiation: IInstantiationService,
  entries: readonly ReviewFilesEditorEntry[],
  files: Map<string, StructuralTextDiff>,
  lifetime: DisposableStore,
  collapsed: CollapseState,
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
        const path = model && pairs.get(model.original.uri.toString() + "\n" + model.modified.uri.toString());
        const regions = widget.unchangedRegions!.read(reader);
        if (!path || !files.has(path)) return;
        const gaps = structuralContextGaps(files.get(path)!, (id) => collapsed.get(path, id) === true, (id) => collapsed.get(path, id));
        const next = new Set<UnchangedRegion>();
        const gapOf = (region: UnchangedRegion) =>
          gaps.find((g) => g.originalStart === region.originalLineNumber && g.modifiedStart === region.modifiedLineNumber && g.label === region.label);
        for (const region of regions) {
          const fullyShown = region.visibleLineCountTop.read(reader) + region.visibleLineCountBottom.read(reader) >= region.lineCount;
          if (fullyShown) {
            next.add(region);
            if (revealed.has(region)) continue;
            const gap = gapOf(region);
            if (!gap) continue;
            collapsed.set(path, gap.foldStateId, false);
          } else if (revealed.has(region)) {
            // Monaco's own fold control closed a region we had marked open.
            const gap = gapOf(region);
            if (!gap) continue;
            collapsed.set(path, gap.foldStateId, true);
          }
        }
        revealed = next;
      }),
    );
  }

  lifetime.add(editors.onDiffEditorAdd(watch));
  for (const editor of editors.listDiffEditors()) watch(editor);
}

/** Collapse state per file, keyed by fold-state id. */
interface CollapseState {
  get(path: string, foldStateId: number): boolean | undefined;
  set(path: string, foldStateId: number, value: boolean): void;
}
