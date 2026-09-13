/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { reviewVirtualUri } from "../common/reviewCodeResources.js";
import { Emitter, Event } from "../../base/common/event.js";
import { DisposableStore, toDisposable } from "../../base/common/lifecycle.js";
import { CancellationError } from "../../base/common/errors.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from "../../platform/instantiation/common/serviceCollection.js";
import { IDiffProviderFactoryService } from "../../editor/browser/widget/diffEditor/diffProviderFactoryService.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import { MouseTargetType, type ICodeEditor, type IDiffEditor } from "../../editor/browser/editorBrowser.js";
import { LineRange } from "../../editor/common/core/ranges/lineRange.js";
import { DetailedLineRangeMapping } from "../../editor/common/diff/rangeMapping.js";
import { autorun, type IObservable } from "../../base/common/observable.js";
import type { UnchangedRegion } from "../../editor/browser/widget/diffEditor/diffEditorViewModel.js";
import { IReviewSessionModelService } from "./reviewSessionModelService.js";
import { reviewDiffFilesUrl } from "../common/reviewReveal.js";
import {
  structuralContextGaps,
  structuralFilePath,
  structuralInitialCounts,
  structuralMoves,
  structuralRows,
  structuralHighlights,
  STRUCTURAL_WIRE_VERSION,
  type StructuralEvent,
  type StructuralFileChange,
  type StructuralFileCounts,
  type StructuralLineCounts,
  type StructuralRegion,
  type StructuralSource,
  type StructuralTextDiff,
} from "../common/reviewStructuralDiff.js";
import type { ReviewCommitScope } from "../common/reviewProtocol.js";
import type { ReviewFilesEditorEntry } from "./reviewFilesDiffView.js";

/** What the stream says about one file once its result arrives. */
export interface StructuralFileOutcome {
  error?: string;
  stats?: StructuralLineCounts;
}

/** Owned by one Files view, including provider registrations and fold listeners. */
export async function prepareStructuralReview(
  instantiation: IInstantiationService,
  entries: readonly ReviewFilesEditorEntry[],
  scope: ReviewCommitScope | undefined,
  lifetime: DisposableStore,
): Promise<{
  instantiation: IInstantiationService;
  enabled: boolean;
  entries: readonly ReviewFilesEditorEntry[];
  load(
    onFile: (path: string, outcome: StructuralFileOutcome) => void,
    onManifest: (files: readonly StructuralFileChange[]) => void,
  ): Promise<void>;
  /** Fires when a file's visible counts change: on arrival and on every fold toggle. */
  onDidChangeCounts: Event<{ path: string; counts: StructuralFileCounts }>;
}> {
  const sessionModel = instantiation.invokeFunction((a) =>
    a.get(IReviewSessionModelService),
  ).activeModel;
  if (!sessionModel) throw new Error("Review session is unavailable.");
  const session = sessionModel.session;
  const files = new Map<string, StructuralTextDiff>();
  const binary = new Set<string>();
  const changed = lifetime.add(new Emitter<void>());
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
  entries = entries.map(entry => ({
    ...entry,
    original: entry.original.scheme === "file" ? entry.original : reviewVirtualUri(
      "base", entry.file.previousPath ?? entry.file.path, entry.file.path,
      session.session.sessionId, scope?.commit,
    ),
    modified: entry.modified.scheme === "file" ? entry.modified : reviewVirtualUri(
      "head", entry.file.path, entry.file.path, session.session.sessionId, scope?.commit,
    ),
  }));
  const pairs = new Map(entries.map(e => [e.original.toString() + "\n" + e.modified.toString(), e.file.path]));
  async function accept(event: Extract<StructuralEvent, { type: "file" }>): Promise<{ path: string; stats?: StructuralLineCounts }> {
    const path = structuralFilePath(event.file);
    const entry = entries.find(e => e.file.path === path);
    if (!entry) throw new Error(`diffr returned an unexpected file: ${path}`);
    if (event.error) throw new Error(event.error.message);
    if (!event.diff) throw new Error(`diffr sent neither a diff nor an error for ${path}.`);
    const diff = event.diff;
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
    changed.fire();
    emitCounts(path);
    return { path, stats: diff.type === "text" ? diff.stats.textual : undefined };
  }
  async function load(
    onFile: (path: string, outcome: StructuralFileOutcome) => void,
    onManifest: (files: readonly StructuralFileChange[]) => void,
  ): Promise<void> {
    const abort = new AbortController();
    lifetime.add(toDisposable(() => abort.abort()));
    const url = reviewDiffFilesUrl(session.sessionUrl, session.session.routePath ?? "/");
    url.pathname = url.pathname.replace(/diff-files$/, "structural-diff");
    const response = await sessionModel!.request(String(url), {
      method: "POST",
      headers: { "x-review-token": session.token, "content-type": "application/json" },
      body: JSON.stringify({ commit: scope?.commit }), signal: abort.signal,
    });
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
      if (complete) throw new Error("diffr emitted data after completion.");
      if (!started) {
        if (event.type === "error") throw new Error(event.message);
        if (event.type !== "start" || event.version !== STRUCTURAL_WIRE_VERSION) throw new Error("Unsupported diffr stream protocol.");
        started = true;
        onManifest(event.files);
      } else if (event.type === "file") {
        const path = structuralFilePath(event.file);
        if (seen.has(path)) throw new Error(`diffr returned a duplicate file: ${path}`);
        seen.add(path);
        try {
          const accepted = await accept(event);
          onFile(accepted.path, { stats: accepted.stats });
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
  attachStructuralEditors(instantiation, entries, files, lifetime, changed.event, {
    get: (path, id) => collapsed.get(collapseKey(path, id)),
    set: (path, id, value) => {
      if (collapsed.get(collapseKey(path, id)) === value) return;
      collapsed.set(collapseKey(path, id), value);
      providerChanged.fire();
    },
  });
  return { instantiation: child, enabled: true, entries, load, onDidChangeCounts: countsChanged.event };
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
  filesChanged: Event<void>,
  collapsed: CollapseState,
): void {
  const editors = instantiation.invokeFunction((a) => a.get(ICodeEditorService));
  const pairs = new Map(entries.map((e) => [e.original.toString() + "\n" + e.modified.toString(), e.file.path]));
  function watch(editor: IDiffEditor) {
    const store = lifetime.add(new DisposableStore());
    store.add(editor.onDidDispose(() => store.dispose()));
    markMoves(editor, store);
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
  /**
   * Moved code: a neutral tint on both copies and a label on each copy's first
   * line naming where the other copy is. Clicking the label reveals it.
   */
  function markMoves(editor: IDiffEditor, store: DisposableStore) {
    const original = editor.getOriginalEditor(), modified = editor.getModifiedEditor();
    const leftDecorations = original.createDecorationsCollection();
    const rightDecorations = modified.createDecorationsCollection();
    const render = () => {
      const model = editor.getModel();
      const path = model && pairs.get(model.original.uri.toString() + "\n" + model.modified.uri.toString());
      const diff = path === undefined || path === null ? undefined : files.get(path);
      if (!diff) {
        leftDecorations.clear();
        rightDecorations.clear();
        return;
      }
      const moves = structuralMoves(diff);
      const side = (ranges: { start: number; end: number }[], labels: string[], targets: { line: number }[]) =>
        ranges.flatMap((range, index) => {
          const lines = [];
          for (let line = range.start; line < range.end; line++) {
            lines.push({
              range: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 },
              options: {
                description: "review-structural-moved",
                isWholeLine: true,
                className: "review-structural-moved",
                ...(line === range.start
                  ? {
                      after: {
                        content: labels[index],
                        inlineClassName: "review-structural-moved-label",
                        cursorStops: 0,
                        attachedData: { reviewMoveTarget: targets[index].line },
                      },
                    }
                  : {}),
              },
            });
          }
          return lines;
        });
      leftDecorations.set(
        side(
          moves.map((m) => m.lhs),
          moves.map((m) => `  Moved to line ${m.rhs.start + 1}`),
          moves.map((m) => ({ line: m.rhs.start + 1 })),
        ),
      );
      rightDecorations.set(
        side(
          moves.map((m) => m.rhs),
          moves.map((m) => `  Moved from line ${m.lhs.start + 1}`),
          moves.map((m) => ({ line: m.lhs.start + 1 })),
        ),
      );
    };
    const follow = (from: ICodeEditor, to: ICodeEditor) =>
      store.add(
        from.onMouseDown((event) => {
          if (event.target.type !== MouseTargetType.CONTENT_TEXT) return;
          const data = event.target.detail.injectedText?.options.attachedData as { reviewMoveTarget?: number } | undefined;
          if (data?.reviewMoveTarget === undefined) return;
          event.event.preventDefault();
          to.revealLineInCenter(data.reviewMoveTarget);
          to.setPosition({ lineNumber: data.reviewMoveTarget, column: 1 });
          to.focus();
        }),
      );
    follow(original, modified);
    follow(modified, original);
    store.add(editor.onDidChangeModel(render));
    store.add(filesChanged(render));
    store.add(toDisposable(() => {
      leftDecorations.clear();
      rightDecorations.clear();
    }));
    render();
  }

  lifetime.add(editors.onDiffEditorAdd(watch));
  for (const editor of editors.listDiffEditors()) watch(editor);
}

/** Collapse state per file, keyed by fold-state id. */
interface CollapseState {
  get(path: string, foldStateId: number): boolean | undefined;
  set(path: string, foldStateId: number, value: boolean): void;
}

