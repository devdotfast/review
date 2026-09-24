import { observableValue } from "../../base/common/observable.js";
import type { ReviewDiffProgressState, ReviewDiffSection } from "../common/reviewProtocol.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Button } from "../../base/browser/ui/button/button.js";
import { isEqual } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import type {
  IResourceLabel,
  IResourceHeaderMetadata,
  IWorkbenchUIElementFactory,
} from "../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js";
import type { IDiffCodeEditorWidgetOptions } from "../../editor/browser/widget/diffEditor/diffEditorWidget.js";
import { FileKind } from "../../platform/files/common/files.js";
import { IHoverService } from "../../platform/hover/browser/hover.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { ResourceLabel } from "../../workbench/browser/labels.js";
import type { ReviewDiffFileWire } from "../common/reviewProtocol.js";
import { reviewCountsTooltip, ReviewTooltip, type ReviewTooltipContent, ReviewViewedCheckbox } from "../browser/reviewTooltip.js";

export interface ReviewMultiDiffHeaderEntry {
  readonly original: URI | undefined;
  readonly modified: URI | undefined;
  readonly additions?: number;
  readonly deletions?: number;
	/** Why the file starts collapsed, e.g. "Generated file · hidden by default". */
	readonly note?: string;
	/** Tooltip for the counts: what is left of the file, then its whole. */
	readonly countsTooltip?: ReviewTooltipContent;
	readonly sectionId?: string;
	readonly section?: ReviewDiffSection;
	readonly sectionCollapsed?: boolean;
	readonly onToggleSectionCollapsed?: () => void;
	readonly onToggleSection?: () => void;
  readonly onDidOpen?: () => void;
	readonly viewedState?: ReviewDiffProgressState;
	readonly onToggleViewed?: () => void;
}

export class ReviewMultiDiffUIElementFactory
  implements IWorkbenchUIElementFactory
{

  alwaysShowScrollbars = false;
  scrollbarBelowResourceHeader = false;

  get headerClickToCollapse(): boolean {
    return !this.hideResourceHeader;
  }


	private readonly headers = new Set<() => void>();

	/** Re-reads every live header's entry, for counts that change without the items changing. */
	refreshHeaders(): void {
		for (const refresh of this.headers) refresh();
	}

  constructor(
    private readonly entries: () => readonly ReviewMultiDiffHeaderEntry[],
    readonly horizontalScrollbar: "auto" | "hidden",
    readonly overflowWidgetsDomNode: HTMLElement | undefined,
    readonly hideResourceHeader = false,
    readonly codeEditorWidgetOptions: IDiffCodeEditorWidgetOptions | undefined,
    @IInstantiationService
    private readonly instantiationService: IInstantiationService,
    @IHoverService private readonly hoverService: IHoverService,
  ) {}

	getResourceSectionId(uris: Parameters<IResourceHeaderMetadata["setUris"]>[0]): string | undefined {
		// Lens entries encode their section identity in both source URI fragments.
		return uris?.modified?.fragment || uris?.original?.fragment || undefined;
	}

	createResourceSectionHeader(element: HTMLElement, sticky = false) {
		const height = observableValue<number>(this, 0);
		const bodyHidden = observableValue(this, false);
		let uris: Parameters<IResourceHeaderMetadata['setUris']>[0];
		let current: ReviewMultiDiffHeaderEntry | undefined;
		const counts = document.createElement('span'); counts.className = 'review-diff-group-counts';
		const countsTooltip = new ReviewTooltip(this.hoverService, counts);
		const viewed = new ReviewViewedCheckbox(this.hoverService, element.ownerDocument, () => current?.onToggleSection?.());
		const refresh = () => {
			const entry = current = uris && this.entries().find(entry => sameResource(entry.original, uris!.original) && sameResource(entry.modified, uris!.modified));
			const section = sticky && entry?.sectionId
				? this.entries().find(candidate => candidate.sectionId === entry.sectionId && candidate.section)?.section
				: entry?.section;
			bodyHidden.set(entry?.sectionCollapsed ?? false, undefined);
			element.replaceChildren(); element.className = 'review-diff-group'; element.hidden = !section;
			height.set(section ? 48 : 0, undefined);
			if (!section) return;
			const toggle = document.createElement('button'); toggle.className = 'review-diff-group-toggle';
			toggle.setAttribute('aria-expanded', String(!entry?.sectionCollapsed));
			toggle.setAttribute('aria-label', `${entry?.sectionCollapsed ? 'Expand' : 'Collapse'} section: ${section.label}`);
			toggle.onclick = () => entry?.onToggleSectionCollapsed?.();
			const chevron = document.createElement('span'); chevron.className = `codicon codicon-chevron-${entry?.sectionCollapsed ? 'right' : 'down'}`;
			const title = document.createElement('span'); title.className = 'review-diff-group-title'; title.textContent = section.label;
			counts.textContent = section.total.additions + section.total.deletions === 0 ? 'Unchanged' : section.state === 'viewed' ? 'Viewed' : section.state === 'folded' ? 'Folded' : `+${compactCount(section.remaining.additions)} −${compactCount(section.remaining.deletions)}`;
			countsTooltip.content = section.total.additions + section.total.deletions === 0 ? undefined : reviewCountsTooltip(section);
			viewed.update(section.state, section.label, section.total.additions + section.total.deletions === 0);
			element.classList.toggle('is-viewed', section.state === 'viewed');
			toggle.append(chevron, title); element.append(toggle, counts, viewed.element);
		};
		this.headers.add(refresh);
		return { height, bodyHidden, setUris: (value: typeof uris) => { uris = value; refresh(); }, dispose: () => { this.headers.delete(refresh); countsTooltip.dispose(); viewed.dispose(); element.remove(); } };
	}

  createResourceLabel(element: HTMLElement): IResourceLabel {
    element.classList.add("review-path-label");
    const label = this.instantiationService.createInstance(
      ResourceLabel,
      element,
      {},
    );
		// A deleted file keeps a legible name: the tree's minus already says
		// deleted, so the header never strikes the path through.
    return {
			setUri: (uri) => {
        if (!uri) {
          label.element.clear();
          return;
        }
        // `setFile` splits the URI into a file name and a folder. The header
        // prints the whole path instead, and the CSS elides it from the left.
        label.element.setResource(
          { resource: uri, name: reviewMultiDiffLabelPath(uri) },
					{ fileKind: FileKind.FILE, forceLabel: true },
        );
      },
			setLabel: (name, description, resource) => {
        if (resource) {
					label.element.setResource({ resource, name, description });
        } else {
					label.element.setLabel(name, description);
        }
      },
      dispose() {
        label.dispose();
      },
    };
  }

  createResourceHeaderMetadata(element: HTMLElement): IResourceHeaderMetadata {
    const ownerDocument = element.ownerDocument;
    const additions = ownerDocument.createElement("span");
    additions.className = "review-multidiff-additions";
    const deletions = ownerDocument.createElement("span");
    deletions.className = "review-multidiff-deletions";
    const counts = ownerDocument.createElement("span");
    counts.className = "review-multidiff-counts";
    counts.append(additions, deletions);
    element.append(counts);
		const note = ownerDocument.createElement("span");
		note.className = "review-multidiff-note";
		element.append(note);

    const openContainer = ownerDocument.createElement("span");
    openContainer.className = "review-multidiff-open-container";
    element.append(openContainer);
    const open = new Button(openContainer, {
      ariaLabel: "Open File",
      title: "Open File",
      supportIcons: true,
    });
		open.label = "Open file";
    open.element.classList.add("review-multidiff-open");
		const countsTooltip = new ReviewTooltip(this.hoverService, counts);
		const viewed = new ReviewViewedCheckbox(this.hoverService, ownerDocument, () => current?.onToggleViewed?.());
		element.append(viewed.element);
    let current: ReviewMultiDiffHeaderEntry | undefined;
		let lastUris: Parameters<IResourceHeaderMetadata["setUris"]>[0];
    const openListener = open.onDidClick(() => current?.onDidOpen?.());
		const refresh = () => setUris(lastUris);
		this.headers.add(refresh);

		const setUris: IResourceHeaderMetadata["setUris"] = (uris) => {
			lastUris = uris;
        current = uris
          ? this.entries().find(
              (entry) =>
                sameResource(entry.original, uris.original) &&
                sameResource(entry.modified, uris.modified),
            )
          : undefined;
        element.hidden = !current;
        if (!current) return;
        const hasCounts =
          current.additions !== undefined && current.deletions !== undefined;
        counts.hidden = !hasCounts;
        if (hasCounts) {
				additions.textContent = `+${compactCount(current.additions!)}`;
				deletions.textContent = `−${compactCount(current.deletions!)}`;
          counts.setAttribute(
            "aria-label",
            `${current.additions} lines added, ${current.deletions} lines removed`,
          );
        }
			countsTooltip.content = current.countsTooltip;
			const path = current.modified ?? current.original;
			viewed.update(current.viewedState, path ? reviewMultiDiffLabelPath(path) : "file", !current.onToggleViewed);
			counts.classList.toggle("review-counts-viewed", current.viewedState === "viewed" || current.viewedState === "folded");
			counts.classList.toggle("review-counts-folded", current.viewedState === "folded");
			if (current.viewedState === "viewed") { additions.textContent = "Viewed"; deletions.textContent = ""; }
			else if (current.viewedState === "folded") {
				// A hidden file's note already says why it is folded.
				additions.textContent = "Folded"; deletions.textContent = "";
				counts.hidden ||= !!current.note;
			}

			note.hidden = !current.note;
			note.textContent = current.note ?? "";
        openContainer.hidden = !current.onDidOpen;
		};
		return {
			setUris,
			dispose: () => {
				this.headers.delete(refresh);
				countsTooltip.dispose();
				viewed.dispose();
        openListener.dispose();
        open.dispose();
        element.replaceChildren();
      },
    };
  }
}

function sameResource(left: URI | undefined, right: URI | undefined): boolean {
  return left === undefined
    ? right === undefined
    : !!right && isEqual(left, right);
}

export function reviewMultiDiffLabelUris(file: ReviewDiffFileWire): {
  readonly original: URI | undefined;
  readonly modified: URI | undefined;
} {
  return {
    original:
      file.status === "added"
        ? undefined
        : reviewFileLabelUri(file.previousPath ?? file.path),
    modified:
      file.status === "deleted"
        ? undefined
        : reviewFileLabelUri(file.path),
  };
}

function reviewFileLabelUri(path: string): URI {
  return URI.from({ scheme: "file", path: `/${path}` });
}

function reviewMultiDiffLabelPath(uri: URI): string {
  return uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
}

const compactCount = (count: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count).toLowerCase();
