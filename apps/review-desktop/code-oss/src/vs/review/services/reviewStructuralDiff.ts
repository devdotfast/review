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
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import { ILanguageFeaturesService } from "../../editor/common/services/languageFeatures.js";
import { LineRange } from "../../editor/common/core/ranges/lineRange.js";
import { DetailedLineRangeMapping } from "../../editor/common/diff/rangeMapping.js";
import { FoldingController } from "../../editor/contrib/folding/browser/folding.js";
import type { FoldingModel } from "../../editor/contrib/folding/browser/foldingModel.js";
import { FoldingRangeKind, type FoldingRangeProvider } from "../../editor/common/languages.js";
import { IReviewSessionModelService } from "./reviewSessionModelService.js";
import { reviewDiffFilesUrl } from "../common/reviewReveal.js";
import {
  nativeFoldRange,
  structuralRows,
  structuralHighlights,
  structuralContextGaps,
  type StructuralDiff,
  type StructuralFileEvent,
} from "../common/reviewStructuralDiff.js";
import type { ReviewCommitScope } from "../common/reviewProtocol.js";
import type { ReviewFilesEditorEntry } from "./reviewFilesDiffView.js";

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
  load(onFile: (path: string, error?: string) => void): Promise<void>;
}> {
  const sessionModel = instantiation.invokeFunction((a) =>
    a.get(IReviewSessionModelService),
  ).activeModel;
  if (!sessionModel) throw new Error("Review session is unavailable.");
  const session = sessionModel.session;
  const files = new Map<string, StructuralDiff>();
  const changed = lifetime.add(new Emitter<void>());
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
  async function accept(event: StructuralFileEvent): Promise<string> {
    const path = event.file.new_path ?? event.file.old_path!;
    const entry = entries.find(e => e.file.path === path);
    if (!entry) throw new Error(`diffr returned an unexpected file: ${path}`);
    const diff = event.diff;
    if (diff.lhs_src !== "Binary" && diff.rhs_src !== "Binary") {
      for (const [uri, text] of [[entry.original, diff.lhs_src.Text], [entry.modified, diff.rhs_src.Text]] as const) {
        if (uri.scheme !== "file" && !modelService.getModel(uri))
          modelService.createModel(text, languages.createByFilepathOrFirstLine(uri), uri);
        const reference = lifetime.add(await resolver.createModelReference(uri));
        if (reference.object.textEditorModel.getValue().replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n"))
          throw new Error("Pinned checkout differs from diffr's source snapshot; reload the review.");
      }
    }
    if (lifetime.isDisposed) throw new CancellationError();
    files.set(path, diff);
    changed.fire();
    return path;
  }
  async function load(onFile: (path: string, error?: string) => void): Promise<void> {
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
      const event = JSON.parse(text);
      if (complete) throw new Error("diffr emitted data after completion.");
      if (!started) {
        if (event.type === "error") throw new Error(event.message);
        if (event.type !== "start" || event.version !== 1) throw new Error("Unsupported diffr stream protocol.");
        started = true;
      } else if (event.type === "file" || event.type === "file_error") {
        const path = event.file.new_path ?? event.file.old_path;
        if (seen.has(path)) throw new Error(`diffr returned a duplicate file: ${path}`);
        seen.add(path);
        if (event.type === "file_error") onFile(path, event.message);
        else {
          try { onFile(await accept(event)); }
          catch (error) {
            if (lifetime.isDisposed) throw error;
            onFile(path, error instanceof Error ? error.message : String(error));
          }
        }
      } else if (event.type === "complete") complete = true;
      else throw new Error(event.message ?? `Unexpected diffr event: ${event.type}`);
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
        onFile(entry.file.path, "diffr did not supply a result for this file.");
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
          const diff = path === undefined ? undefined : files.get(path);
          if (!diff) throw new Error("diffr did not supply a result for this file.");
          if (diff.lhs_src === "Binary" || diff.rhs_src === "Binary") {
            return { changes: [], moves: [], identical: false, quitEarly: false, changeHighlights: { original: [], modified: [] } };
          }
          const left = diff.lhs_src.Text.replace(/\r\n/g, "\n");
          const right = diff.rhs_src.Text.replace(/\r\n/g, "\n");
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
            contextGaps: structuralContextGaps(diff),
            changeHighlights: structuralHighlights(diff),
          };
        },
      };
    },
  };
  const child = lifetime.add(
    instantiation.createChild(new ServiceCollection([IDiffProviderFactoryService, factory])),
  );
  attachStructuralEditors(instantiation, entries, files, lifetime, changed.event);
  return { instantiation: child, enabled: true, entries, load };
}

function attachStructuralEditors(
  instantiation: IInstantiationService,
  entries: readonly ReviewFilesEditorEntry[],
  files: Map<string, StructuralDiff>,
  lifetime: DisposableStore,
  onDidLoad: Event<void>,
): void {
  const features = instantiation.invokeFunction((a) => a.get(ILanguageFeaturesService));
  const editors = instantiation.invokeFunction((a) => a.get(ICodeEditorService));
  const sources = new Map<string, { side: 0 | 1; pair: string }>();
  for (const entry of entries) {
    sources.set(entry.original.toString(), { side: 0, pair: entry.file.path });
    sources.set(entry.modified.toString(), { side: 1, pair: entry.file.path });
  }
  const provider: FoldingRangeProvider = {
    id: "review-diffr",
    onDidChange: Event.map(onDidLoad, () => provider),
    provideFoldingRanges(model) {
      const source = sources.get(model.uri.toString());
      const diff = source && files.get(source.pair);
      if (!source || !diff) return null;
      return (source.side === 0 ? diff.lhs_folds : diff.rhs_folds).flatMap(
        (fold) => {
          const range = nativeFoldRange(fold.range);
          return range
            ? [
                {
                  ...range,
                  kind: fold.tags.includes("imports")
                    ? FoldingRangeKind.Imports
                    : FoldingRangeKind.Region,
                },
              ]
            : [];
        },
      );
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
  const collapsed = new Map<string, boolean>();
  let synchronizing = false;
  function watch(editor: ICodeEditor) {
    const store = lifetime.add(new DisposableStore());
    const binding = store.add(new DisposableStore());
    let generation = 0;
    const bind = async () => {
      const current = ++generation;
      await Promise.resolve();
      if (store.isDisposed || current !== generation) return;
      binding.clear();
      const model = editor.getModel();
      const source = model && sources.get(model.uri.toString());
      const diff = source && files.get(source.pair);
      if (!model || !source || !diff) return;
      const folds = source.side === 0 ? diff.lhs_folds : diff.rhs_folds;
      const folding = await FoldingController.get(editor)?.getFoldingModel();
      if (!folding || binding.isDisposed || current !== generation || editor.getModel() !== model)
        return;
      const modelKey = `${source.pair}:${source.side}`;
      const members = models.get(modelKey) ?? new Set<FoldingModel>();
      members.add(folding);
      models.set(modelKey, members);
      binding.add(toDisposable(() => members.delete(folding)));
      const keyFor = (fold: (typeof folds)[number]) => {
        const range =
          source.side === 1 && fold.match_kind !== "Novel"
            ? fold.match_kind.Unchanged.opposite
            : fold.range;
        const side = fold.match_kind === "Novel" ? source.side : 0;
        return `${source.pair}:${side}:${JSON.stringify(range)}`;
      };
      const restore = () => {
        const toggle = [];
        for (const fold of folds) {
          const range = nativeFoldRange(fold.range);
          if (!range) continue;
          const region = folding.getRegionAtLine(range.start);
          if (region?.startLineNumber !== range.start || region.endLineNumber !== range.end)
            continue;
          if (region.isCollapsed !== (collapsed.get(keyFor(fold)) ?? false)) toggle.push(region);
        }
        if (toggle.length) folding.toggleCollapseState(toggle);
      };
      binding.add(
        folding.onDidChange((event) => {
          if (synchronizing) return;
          synchronizing = true;
          try {
            for (const region of event.collapseStateChanged ?? []) {
              const fold = folds.find((f) => {
                const r = nativeFoldRange(f.range);
                return r?.start === region.startLineNumber && r.end === region.endLineNumber;
              });
              if (!fold) continue;
              collapsed.set(keyFor(fold), region.isCollapsed);
              if (fold.match_kind === "Novel") continue;
              const opposite = nativeFoldRange(fold.match_kind.Unchanged.opposite);
              if (!opposite) continue;
              for (const other of models.get(`${source.pair}:${1 - source.side}`) ?? []) {
                const target = other.getRegionAtLine(opposite.start);
                if (
                  target?.startLineNumber === opposite.start &&
                  target.endLineNumber === opposite.end &&
                  target.isCollapsed !== region.isCollapsed
                )
                  other.toggleCollapseState([target]);
              }
            }
            if (!event.collapseStateChanged) restore();
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
