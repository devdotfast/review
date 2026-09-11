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
import type { ICodeEditor, IViewZone } from "../../editor/browser/editorBrowser.js";
import { ILanguageFeaturesService } from "../../editor/common/services/languageFeatures.js";
import { LineRange } from "../../editor/common/core/ranges/lineRange.js";
import type { IModelDeltaDecoration } from "../../editor/common/model.js";
import { DetailedLineRangeMapping } from "../../editor/common/diff/rangeMapping.js";
import { FoldingController } from "../../editor/contrib/folding/browser/folding.js";
import type { FoldingModel } from "../../editor/contrib/folding/browser/foldingModel.js";
import { FoldingRangeKind, type FoldingRangeProvider } from "../../editor/common/languages.js";
import { IReviewSessionModelService } from "./reviewSessionModelService.js";
import { reviewDiffFilesUrl } from "../common/reviewReveal.js";
import {
  structuralFilePath,
  structuralFoldRanges,
  structuralVisibleCounts,
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
  /** Collapse state by `${path}:${side}:${region id}`, seeded from the wire's initial visibility. */
  const collapsed = new Map<string, boolean>();
  const collapseKey = (path: string, side: 0 | 1, id: number) => `${path}:${side}:${id}`;
  const countsChanged = lifetime.add(new Emitter<{ path: string; counts: StructuralFileCounts }>());
  const emitCounts = (path: string) => {
    const diff = files.get(path);
    if (!diff) return;
    countsChanged.fire({
      path,
      counts: structuralVisibleCounts(diff, (side, id) => collapsed.get(collapseKey(path, side, id)) === true),
    });
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
      files.set(path, diff);
      for (const [side, source] of [[0, diff.lhs], [1, diff.rhs]] as const) {
        for (const { region } of structuralFoldRanges(source?.regions)) {
          const key = collapseKey(path, side, region.id);
          if (!collapsed.has(key)) collapsed.set(key, region.visibility?.collapsed === true);
        }
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
  const factory: IDiffProviderFactoryService = {
    _serviceBrand: undefined,
    createDiffProvider() {
      return {
        onDidChange: Event.None,
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
          const ls = left.split("\n"),
            rs = right.split("\n");
          for (const [a, b] of rows) {
            const changed = a === null || b === null || ls[a] !== rs[b];
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
            // Context gaps are collapsed regions in the one fold model below.
            contextGaps: [],
            changeHighlights: structuralHighlights(diff),
          };
        },
      };
    },
  };
  const child = lifetime.add(
    instantiation.createChild(new ServiceCollection([IDiffProviderFactoryService, factory])),
  );
  attachStructuralEditors(instantiation, entries, files, lifetime, changed.event, {
    get: (path, side, id) => collapsed.get(collapseKey(path, side, id)),
    set: (path, side, id, value) => {
      collapsed.set(collapseKey(path, side, id), value);
      emitCounts(path);
    },
  });
  return { instantiation: child, enabled: true, entries, load, onDidChangeCounts: countsChanged.event };
}

/** The folding regions of one side, indexed for the editor bindings. */
interface SideFolds {
  entries: { region: StructuralRegion; range: { start: number; end: number } }[];
  rangeById: Map<number, { start: number; end: number }>;
  byRange: Map<string, StructuralRegion>;
}

function sideFolds(source: StructuralSource | undefined): SideFolds {
  const entries = structuralFoldRanges(source?.regions);
  return {
    entries,
    rangeById: new Map(entries.map(({ region, range }) => [region.id, range])),
    byRange: new Map(entries.map(({ region, range }) => [`${range.start}:${range.end}`, region])),
  };
}

interface CollapseState {
  get(path: string, side: 0 | 1, id: number): boolean | undefined;
  set(path: string, side: 0 | 1, id: number, value: boolean): void;
}

function attachStructuralEditors(
  instantiation: IInstantiationService,
  entries: readonly ReviewFilesEditorEntry[],
  files: Map<string, StructuralTextDiff>,
  lifetime: DisposableStore,
  onDidLoad: Event<void>,
  collapsed: CollapseState,
): void {
  const features = instantiation.invokeFunction((a) => a.get(ILanguageFeaturesService));
  const editors = instantiation.invokeFunction((a) => a.get(ICodeEditorService));
  const sources = new Map<string, { side: 0 | 1; pair: string }>();
  for (const entry of entries) {
    sources.set(entry.original.toString(), { side: 0, pair: entry.file.path });
    sources.set(entry.modified.toString(), { side: 1, pair: entry.file.path });
  }
  const foldsFor = (pair: string, side: 0 | 1): SideFolds | undefined => {
    const diff = files.get(pair);
    return diff && sideFolds(side === 0 ? diff.lhs : diff.rhs);
  };
  // One fold model for every region: syntax folds and context gaps alike.
  // Paired regions share collapse state through their id.
  const provider: FoldingRangeProvider = {
    id: "review-diffr",
    onDidChange: Event.map(onDidLoad, () => provider),
    provideFoldingRanges(model) {
      const source = sources.get(model.uri.toString());
      const folds = source && foldsFor(source.pair, source.side);
      if (!source || !folds) return null;
      return folds.entries.map(({ region, range }) => ({
        ...range,
        kind: region.tags?.includes("import") ? FoldingRangeKind.Imports : FoldingRangeKind.Region,
      }));
    },
  };
  lifetime.add(
    features.foldingRangeProvider.register(
      entries
        .flatMap((entry) => [entry.original, entry.modified])
        .map((uri) => ({
          scheme: uri.scheme,
          pattern: uri.path.replace(/[\[\]*?{}]/g, (character) => `[${character}]`),
          exclusive: true,
        })),
      provider,
    ),
  );
  const models = new Map<string, Set<FoldingModel>>();
  let synchronizing = false;
  function watch(editor: ICodeEditor) {
    const store = lifetime.add(new DisposableStore());
    const binding = store.add(new DisposableStore());
    const labels = new StructuralLabels(editor);
    store.add(labels);
    let generation = 0;
    const bind = async () => {
      const current = ++generation;
      await Promise.resolve();
      if (store.isDisposed || current !== generation) return;
      binding.clear();
      labels.clear();
      const model = editor.getModel();
      const source = model && sources.get(model.uri.toString());
      const folds = source && foldsFor(source.pair, source.side);
      if (!model || !source || !folds) return;
      const folding = await FoldingController.get(editor)?.getFoldingModel();
      if (!folding || binding.isDisposed || current !== generation || editor.getModel() !== model)
        return;
      const modelKey = `${source.pair}:${source.side}`;
      const members = models.get(modelKey) ?? new Set<FoldingModel>();
      members.add(folding);
      models.set(modelKey, members);
      binding.add(toDisposable(() => members.delete(folding)));
      const isCollapsed = (region: StructuralRegion) => collapsed.get(source.pair, source.side, region.id) === true;
      const shownLabels = () => folds.entries.filter(({ region }) => isCollapsed(region));
      const restore = () => {
        const toggle = [];
        for (const { region, range } of folds.entries) {
          const native = folding.getRegionAtLine(range.start);
          if (native?.startLineNumber !== range.start || native.endLineNumber !== range.end)
            continue;
          if (native.isCollapsed !== isCollapsed(region)) toggle.push(native);
        }
        if (toggle.length) folding.toggleCollapseState(toggle);
        labels.sync(shownLabels());
      };
      binding.add(
        folding.onDidChange((event) => {
          if (synchronizing) return;
          synchronizing = true;
          try {
            for (const native of event.collapseStateChanged ?? []) {
              const region = folds.byRange.get(`${native.startLineNumber}:${native.endLineNumber}`);
              if (!region) continue;
              collapsed.set(source.pair, source.side, region.id, native.isCollapsed);
              const oppositeSide = source.side === 0 ? 1 : 0;
              const oppositeRange = foldsFor(source.pair, oppositeSide)?.rangeById.get(region.id);
              if (!oppositeRange) continue;
              collapsed.set(source.pair, oppositeSide, region.id, native.isCollapsed);
              for (const other of models.get(`${source.pair}:${oppositeSide}`) ?? []) {
                const target = other.getRegionAtLine(oppositeRange.start);
                if (
                  target?.startLineNumber === oppositeRange.start &&
                  target.endLineNumber === oppositeRange.end &&
                  target.isCollapsed !== native.isCollapsed
                )
                  other.toggleCollapseState([target]);
              }
            }
            if (!event.collapseStateChanged) restore();
            else labels.sync(shownLabels());
          } finally {
            synchronizing = false;
          }
        }),
      );
      restore();
    };
    const update = () => {
      void bind().catch((error) => console.error("Structural editor binding failed", error));
    };
    store.add(onDidLoad(update));
    store.add(editor.onDidChangeModel(update));
    store.add(editor.onDidChangeConfiguration(update));
    store.add(editor.onDidDispose(() => store.dispose()));
    update();
  }
  lifetime.add(editors.onCodeEditorAdd(watch));
  for (const editor of editors.listCodeEditors()) watch(editor);
}

/**
 * The text a collapsed region shows. The header line keeps Monaco's inline
 * `⋯`; a one-line label follows it as injected text, and a multi-line label
 * (pseudocode) hangs under the header as a view zone in the fold tint.
 */
class StructuralLabels {
  private readonly decorations;
  private readonly zones = new Map<number, string>();
  private shown = new Map<number, string>();

  constructor(private readonly editor: ICodeEditor) {
    this.decorations = editor.createDecorationsCollection();
  }

  sync(entries: readonly { region: StructuralRegion; range: { start: number; end: number } }[]): void {
    const next = new Map<number, string>();
    for (const { region } of entries) {
      const label = region.visibility?.label;
      if (label) next.set(region.id, label);
    }
    if (sameLabels(this.shown, next)) return;
    this.shown = next;
    const decorations: IModelDeltaDecoration[] = [];
    const model = this.editor.getModel();
    this.editor.changeViewZones((accessor) => {
      for (const id of this.zones.values()) accessor.removeZone(id);
      this.zones.clear();
      if (!model) return;
      for (const { region, range } of entries) {
        const label = next.get(region.id);
        if (!label) continue;
        const lines = label.split("\n");
        if (lines.length === 1) {
          const column = model.getLineMaxColumn(range.start);
          decorations.push({
            range: { startLineNumber: range.start, startColumn: column, endLineNumber: range.start, endColumn: column },
            options: {
              description: "review-structural-label",
              after: { content: ` ${label}`, inlineClassName: "review-structural-label-inline" },
            },
          });
          continue;
        }
        const domNode = document.createElement("div");
        domNode.className = "review-structural-label-zone";
        const pre = document.createElement("pre");
        pre.textContent = label;
        domNode.append(pre);
        const zone: IViewZone = { afterLineNumber: range.start, heightInLines: lines.length, domNode };
        this.zones.set(region.id, accessor.addZone(zone));
      }
    });
    this.decorations.set(decorations);
  }

  clear(): void {
    this.sync([]);
  }

  dispose(): void {
    this.clear();
    this.decorations.clear();
  }
}

function sameLabels(left: Map<number, string>, right: Map<number, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [id, label] of left) if (right.get(id) !== label) return false;
  return true;
}
