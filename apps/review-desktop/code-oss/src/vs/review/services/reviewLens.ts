/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/
import { isDisposable, type DisposableStore } from '../../base/common/lifecycle.js';
import { IDiffProviderFactoryService } from '../../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { Event } from '../../base/common/event.js';
import { lensContextGaps, viewedContextGaps } from '../common/reviewLens.js';
import type { ReviewDiffLens, ReviewDiffProgress } from '../common/reviewProtocol.js';
import type { ReviewFilesEditorEntry } from './reviewFilesDiffView.js';

export function lensRanges(lens: ReviewDiffLens, entry: ReviewFilesEditorEntry): Extract<ReviewDiffLens['targets'][number], {kind: 'ranges'}>['ranges'] {
  return lens.targets.flatMap(target => target.kind === "ranges" ? [...target.ranges] : []).filter(range => range.file === (range.side === 'base' ? entry.file.previousPath ?? entry.file.path : entry.file.path));
}

/** Preserve each result's identity even when several sections show the same file. */
export function selectLensEntries(entries: readonly ReviewFilesEditorEntry[], lens: ReviewDiffLens | undefined, sections: ReviewDiffProgress["sections"]): readonly ReviewFilesEditorEntry[] {
  if (!lens) return entries;
  const select = (targets: ReviewDiffLens["targets"]) => {
    const results = new Set(targets.flatMap(target => target.kind === "results" ? target.results.map(result => JSON.stringify(result)) : []));
    return entries.flatMap(entry => {
      if (entry.evidence) return results.has(JSON.stringify(entry.evidence)) ? [entry] : [];
      const ranges = lensRanges({ ...lens, targets }, entry);
      if (!ranges.length) return [];
      if (lens.wholeFiles) return [entry];
      const original = ranges.some(range => range.side === "base") ? entry.original : undefined;
      const modified = ranges.some(range => range.side === "head") ? entry.modified : undefined;
      return [{ ...entry, original, modified, goToFileResource: (modified ?? original)! }];
    });
  };
  if (!sections?.length) return select(lens.targets);
  return sections.flatMap(section => select(section.targets).map((entry, index) => ({
    ...entry, sectionId: section.id, sectionStart: index === 0,
    original: entry.original?.with({ fragment: `${entry.original.fragment}/${section.id}` }),
    modified: entry.modified?.with({ fragment: `${entry.modified.fragment}/${section.id}` }),
  })));
}

export function withLens(instantiation: IInstantiationService, entries: readonly ReviewFilesEditorEntry[], lens: ReviewDiffLens | undefined, lifetime: DisposableStore, progress: () => ReviewDiffProgress | undefined, onProgress: Event<void>): IInstantiationService {
  const delegate = instantiation.invokeFunction(a => a.get(IDiffProviderFactoryService));
  const factory: IDiffProviderFactoryService = {
    _serviceBrand: undefined,
    createDiffProvider(options) {
      const provider = delegate.createDiffProvider(options);
      if (isDisposable(provider)) lifetime.add(provider);
      return {
        onDidChange: Event.any(provider.onDidChange, onProgress),
        async computeDiff(original, modified, options, token) {
          let diff = await provider.computeDiff(original, modified, options, token);
          const entry = entries.find(entry => entry.original?.toString() === original.uri.toString() || entry.modified?.toString() === modified.uri.toString());
          if (!entry || entry.evidence) return diff;
          const file = progress()?.files.find(file => file.path === entry.file.path);
          if (file && (!lens || lens.wholeFiles) && !diff.contextGaps) diff = { ...diff, contextGaps: lensContextGaps(diff, original.getLineCount(), modified.getLineCount(), file.changedRanges).map(gap => ({ ...gap, label: 'Unchanged' })) };
          if (file) diff = { ...diff, contextGaps: viewedContextGaps(diff, original.getLineCount(), modified.getLineCount(), file.viewedRanges, file.changedRanges) };
          if (file?.unfoldRanges?.length) diff = { ...diff, contextGaps: diff.contextGaps?.map(gap => file.unfoldRanges!.some(range => {
            const start = range.side === 'base' ? gap.originalStart : gap.modifiedStart;
            const count = range.side === 'base' ? gap.originalCount : gap.modifiedCount;
            return count > 0 && range.fromLine < start + count && range.toLine >= start;
          }) ? { ...gap, collapsed: false } : gap) };
          const section = progress()?.sections?.find(section => section.id === entry.sectionId);
          return lens && !lens.wholeFiles ? { ...diff, contextGaps: lensContextGaps(diff, original.getLineCount(), modified.getLineCount(), lensRanges(section ? { ...lens, targets: [{kind: "ranges", ranges: section.sources}] } : lens, entry)) } : diff;
        },
      };
    },
  };
  return lifetime.add(instantiation.createChild(new ServiceCollection([IDiffProviderFactoryService, factory])));
}
