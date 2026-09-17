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

export function lensRanges(lens: ReviewDiffLens, entry: ReviewFilesEditorEntry): ReviewDiffLens['ranges'] {
  return lens.ranges.filter(range => range.file === (range.side === 'base' ? entry.file.previousPath ?? entry.file.path : entry.file.path));
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
          if (!entry) return diff;
          const file = progress()?.files.find(file => file.path === entry.file.path);
          if (file && (!lens || lens.wholeFiles) && !diff.contextGaps) diff = { ...diff, contextGaps: lensContextGaps(diff, original.getLineCount(), modified.getLineCount(), file.changedRanges).map(gap => ({ ...gap, label: 'Unchanged' })) };
          if (file) diff = { ...diff, contextGaps: viewedContextGaps(diff, original.getLineCount(), modified.getLineCount(), file.viewedRanges, file.changedRanges) };
          if (file?.unfoldRanges?.length) diff = { ...diff, contextGaps: diff.contextGaps?.map(gap => file.unfoldRanges!.some(range => {
            const start = range.side === 'base' ? gap.originalStart : gap.modifiedStart;
            const count = range.side === 'base' ? gap.originalCount : gap.modifiedCount;
            return count > 0 && range.fromLine < start + count && range.toLine >= start;
          }) ? { ...gap, collapsed: false } : gap) };
          const section = progress()?.sections?.find(section => section.id === entry.sectionId);
          return lens && !lens.wholeFiles ? { ...diff, contextGaps: lensContextGaps(diff, original.getLineCount(), modified.getLineCount(), lensRanges(section ? { ...lens, ranges: section.sources } : lens, entry)) } : diff;
        },
      };
    },
  };
  return lifetime.add(instantiation.createChild(new ServiceCollection([IDiffProviderFactoryService, factory])));
}
