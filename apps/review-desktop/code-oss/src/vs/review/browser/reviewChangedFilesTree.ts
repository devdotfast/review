/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildTree, type ChangedFileElement, type ChangedTreeElement } from "../common/reviewChangedFilesModel.js";

import { $, append } from "../../base/browser/dom.js";
import type { IListVirtualDelegate } from "../../base/browser/ui/list/list.js";
import { RenderIndentGuides } from "../../base/browser/ui/tree/abstractTree.js";
import type {
  ICompressedTreeElement,
  ICompressedTreeNode,
} from "../../base/browser/ui/tree/compressedObjectTreeModel.js";
import type { ICompressibleTreeRenderer } from "../../base/browser/ui/tree/objectTree.js";
import {
  ObjectTreeElementCollapseState,
  type ITreeNode,
} from "../../base/browser/ui/tree/tree.js";
import { Codicon } from "../../base/common/codicons.js";
import { Emitter, type Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { ThemeIcon } from "../../base/common/themables.js";
import { localize } from "../../nls.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { WorkbenchCompressibleObjectTree } from "../../platform/list/browser/listService.js";
import { registerColor } from "../../platform/theme/common/colorRegistry.js";
import type { ReviewDiffFileWire, ReviewDiffProgressFile, StructuralLineCounts } from "../common/reviewProtocol.js";

registerColor(
  "gitDecoration.addedResourceForeground",
  {
    light: "#587c0c",
    dark: "#81b88b",
    hcDark: "#a1e3ad",
    hcLight: "#374e06",
  },
  localize("review.gitDecoration.added", "Color for added file resources."),
);
registerColor(
  "gitDecoration.modifiedResourceForeground",
  {
    light: "#895503",
    dark: "#E2C08D",
    hcDark: "#E2C08D",
    hcLight: "#895503",
  },
  localize("review.gitDecoration.modified", "Color for modified file resources."),
);
registerColor(
  "gitDecoration.deletedResourceForeground",
  {
    light: "#ad0707",
    dark: "#c74e39",
    hcDark: "#c74e39",
    hcLight: "#ad0707",
  },
  localize("review.gitDecoration.deleted", "Color for deleted file resources."),
);
registerColor(
  "gitDecoration.renamedResourceForeground",
  {
    light: "#007100",
    dark: "#73C991",
    hcDark: "#73C991",
    hcLight: "#007100",
  },
  localize("review.gitDecoration.renamed", "Color for renamed file resources."),
);

const CHANGED_FILE_ROW_HEIGHT = 22;

interface ChangedFilesTreeTemplate {
  readonly row: HTMLElement;
  readonly icon: HTMLElement;
  readonly label: HTMLElement;
	readonly counts: HTMLElement;
}

class ChangedFilesTreeDelegate
  implements IListVirtualDelegate<ChangedTreeElement>
{
  getHeight(): number {
    return CHANGED_FILE_ROW_HEIGHT;
  }

  getTemplateId(): string {
    return ChangedFilesTreeRenderer.TEMPLATE_ID;
  }
}

export class ChangedFilesTreeRenderer
  implements
    ICompressibleTreeRenderer<
      ChangedTreeElement,
      void,
      ChangedFilesTreeTemplate
    >
{
  static readonly TEMPLATE_ID = "review.changedFiles.entry";
  readonly templateId = ChangedFilesTreeRenderer.TEMPLATE_ID;

	constructor(private readonly counts: Map<string, StructuralLineCounts>, private readonly progress: Map<string, ReviewDiffProgressFile>, private readonly states: Map<string, { status: "loading" | "error"; message?: string }>) { }

  renderTemplate(container: HTMLElement): ChangedFilesTreeTemplate {
    const row = append(container, $(".review-changed-files-row"));
    const icon = append(row, $("span.review-changed-files-icon"));
    icon.setAttribute("aria-hidden", "true");
    const label = append(row, $("span.review-changed-files-label"));
		const counts = append(row, $("span.review-tree-counts"));
		return { row, icon, label, counts };
  }

  renderElement(
    node: ITreeNode<ChangedTreeElement>,
    _index: number,
    template: ChangedFilesTreeTemplate,
  ): void {
    this.renderElements([node.element], template);
  }

  renderCompressedElements(
    node: ITreeNode<ICompressedTreeNode<ChangedTreeElement>>,
    _index: number,
    template: ChangedFilesTreeTemplate,
  ): void {
    this.renderElements(node.element.elements, template);
  }

  disposeTemplate(_template: ChangedFilesTreeTemplate): void {}

  private renderElements(
    elements: readonly ChangedTreeElement[],
    template: ChangedFilesTreeTemplate,
  ): void {
    const element = elements[elements.length - 1];
    const isFile = element.kind === "file";

    template.row.classList.toggle("review-changed-files-folder", !isFile);
		const done = isFile ? this.progress.get(element.file.path)?.state : undefined;
		// Folded files read as done, like viewed ones: greyed, with the reason in place of counts.
		template.row.classList.toggle("review-file-viewed", done === "viewed");
		template.row.classList.toggle("review-file-folded", done === "folded");
    template.icon.hidden = !isFile;
    template.icon.className = isFile
      ? `review-changed-files-icon review-changed-files-icon-${element.file.status} ${ThemeIcon.asClassName(fileStatusIcon(element.file.status))}`
      : "review-changed-files-icon";
		template.counts.hidden = !isFile;
		template.counts.replaceChildren();
		template.counts.removeAttribute("title");
		if (isFile) {
			const progress = this.progress.get(element.file.path);
			const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n).toLowerCase();
			const additions = progress?.remaining.additions ?? this.counts.get(element.file.path)?.added;
			const deletions = progress?.remaining.deletions ?? this.counts.get(element.file.path)?.removed;
			if (element.file.status === 'unchanged') template.counts.textContent = 'Unchanged';
			else if (progress?.state === 'viewed') template.counts.textContent = 'Viewed';
			else if (progress?.state === 'folded') template.counts.textContent = 'Folded';
			else if (additions !== undefined && deletions !== undefined) {
				const added = append(template.counts, $('span.review-tree-added')); added.textContent = `+${compact(additions)}`;
				const removed = append(template.counts, $('span.review-tree-removed')); removed.textContent = `−${compact(deletions)}`;
			}
			template.counts.title = additions === undefined ? "Waiting for structural coverage" : element.file.status === "unchanged" ? "Referenced context; no changed lines" : progress?.state === "folded" ? `Folded by default; counted as done · Total +${progress.total.additions} −${progress.total.deletions}` : `Remaining +${additions} −${deletions} · Total +${progress?.total.additions ?? this.counts.get(element.file.path)?.added} −${progress?.total.deletions ?? this.counts.get(element.file.path)?.removed}`;
		}
		const state = isFile ? this.states.get(element.file.path) : undefined;
		if (state) template.icon.className = `review-changed-files-icon codicon codicon-${state.status === "loading" ? "loading codicon-modifier-spin" : "error"}`;
		template.row.title = state?.message ?? (state?.status === "loading" ? "Loading diff…" : "");
		template.row.setAttribute("aria-busy", String(state?.status === "loading"));
    template.label.textContent = isFile
      ? element.name
      : elements.map((item) => item.name).join("/");
  }
}

/** A Workbench-compressed tree over one Review's changed files. */
export class ReviewChangedFilesTree extends Disposable {
  private readonly _onDidOpenFile = this._register(
    new Emitter<ReviewDiffFileWire>(),
  );
  readonly onDidOpenFile: Event<ReviewDiffFileWire> =
    this._onDidOpenFile.event;

  private readonly tree: WorkbenchCompressibleObjectTree<
    ChangedTreeElement,
    void
  >;
  private readonly fileElements = new Map<string, ChangedFileElement>();
  private files: readonly ReviewDiffFileWire[] = [];
	private readonly states = new Map<string, { status: "loading" | "error"; message?: string }>();
  private activePath: string | undefined;
	private readonly counts = new Map<string, StructuralLineCounts>();
	setCounts(path: string, counts: StructuralLineCounts): void {
		const previous = this.counts.get(path);
		this.counts.set(path, counts);
		if (previous?.added !== counts.added || previous?.removed !== counts.removed) this.refreshFile(path);
	}
	private readonly progress = new Map<string, ReviewDiffProgressFile>();
	setProgressFiles(files: readonly ReviewDiffProgressFile[]): void {
		const previous = new Map(this.progress);
		this.progress.clear();
		for (const file of files) this.progress.set(file.path, file);
		for (const path of new Set([...previous.keys(), ...this.progress.keys()])) {
			const before = previous.get(path), after = this.progress.get(path);
			if (before?.state !== after?.state ||
				before?.remaining.additions !== after?.remaining.additions ||
				before?.remaining.deletions !== after?.remaining.deletions ||
				before?.total.additions !== after?.total.additions ||
				before?.total.deletions !== after?.total.deletions) this.refreshFile(path);
		}
	}

	private refreshFile(path: string): void {
		// The parameterless rerender only remeasures dynamic heights; these rows
		// have fixed heights. Target the model node to refresh its rendered data.
		const element = this.fileElements.get(path);
		if (element) this.tree.rerender(element);
	}
  private syncingActiveFile = false;

  constructor(
    container: HTMLElement,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super();
    container.classList.add("review-changed-files");
    const treeContainer = append(
      container,
      $(".review-changed-files-tree"),
    );
		const renderer = new ChangedFilesTreeRenderer(this.counts, this.progress, this.states);
    this.tree = this._register(
      instantiationService.createInstance(
        WorkbenchCompressibleObjectTree<ChangedTreeElement, void>,
        "ReviewChangedFiles",
        treeContainer,
        new ChangedFilesTreeDelegate(),
        [renderer],
        {
          accessibilityProvider: {
            getAriaLabel: (element) =>
              element.kind === "file" ? element.file.path : element.path,
            getWidgetAriaLabel: () =>
              localize("review.changedFiles.ariaLabel", "Changed files"),
          },
          alwaysConsumeMouseWheel: false,
          horizontalScrolling: false,
          identityProvider: {
            getId: (element) =>
              element.kind === "file"
                ? element.file.path
                : `dir:${element.path}`,
          },
          indent: 12,
          keyboardNavigationLabelProvider: {
            getKeyboardNavigationLabel: (element) => element.name,
            getCompressedNodeKeyboardNavigationLabel: (elements) =>
              elements.map((element) => element.name).join("/"),
          },
          compressionEnabled: true,
          multipleSelectionSupport: false,
          openOnSingleClick: true,
          renderIndentGuides: RenderIndentGuides.None,
        },
      ),
    );
    this._register(
      this.tree.onDidOpen((event) => {
        if (this.syncingActiveFile || event.element?.kind !== "file") return;
        this._onDidOpenFile.fire(event.element.file);
      }),
    );
    this.refresh();
  }

  setFiles(files: readonly ReviewDiffFileWire[]): void {
    const selectedElement = this.tree
      .getSelection()
      .find((element) => element?.kind === "file");
    const selectedPath =
      selectedElement?.kind === "file" ? selectedElement.file.path : undefined;
    this.files = files;
    this.refresh(selectedPath);
  }

	setFileState(path: string, status: "loading" | "error" | undefined, message?: string): void {
		if (status) this.states.set(path, { status, message });
		else this.states.delete(path);
		const element = this.fileElements.get(path);
		if (element) this.tree.rerender(element);
	}

	setActiveFile(path: string | undefined, reveal = true): void {
		if (!reveal && this.activePath === path) return;
    this.activePath = path;
		this.syncSelection(path, reveal);
  }

  layout(height: number, width: number): void {
    this.tree.layout(Math.max(0, height), width);
  }

  private refresh(selectedPath?: string): void {
    const roots = buildTree(this.files);
    this.fileElements.clear();
    collectFileElements(roots, this.fileElements);
    this.tree.setChildren(null, toTreeElements(roots));
    this.syncSelection(this.activePath ?? selectedPath);
  }

	private syncSelection(path: string | undefined, reveal = true): void {
    const element = path ? this.fileElements.get(path) : undefined;
    this.syncingActiveFile = true;
    try {
      this.tree.setSelection(element ? [element] : []);
      this.tree.setFocus(element ? [element] : []);
			if (element && reveal) this.tree.reveal(element);
    } finally {
      this.syncingActiveFile = false;
    }
  }
}

function fileStatusIcon(status: ReviewDiffFileWire["status"]): ThemeIcon {
	if (status === "unchanged") return Codicon.file;
  if (status === "added") return Codicon.diffAdded;
  if (status === "deleted") return Codicon.diffRemoved;
  if (status === "renamed") return Codicon.diffRenamed;
  return Codicon.diffModified;
}

function toTreeElements(
  elements: readonly ChangedTreeElement[],
): ICompressedTreeElement<ChangedTreeElement>[] {
  return elements.map((element) =>
    element.kind === "file"
      ? { element, incompressible: true }
      : {
          element,
          collapsible: true,
          collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded,
          children: toTreeElements(element.children),
        },
  );
}

function collectFileElements(
  elements: readonly ChangedTreeElement[],
  target: Map<string, ChangedFileElement>,
): void {
  for (const element of elements) {
    if (element.kind === "file") {
      target.set(element.file.path, element);
    } else {
      collectFileElements(element.children, target);
    }
  }
}

