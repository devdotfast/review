/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import type { ReviewDiffFileWire } from "../common/reviewProtocol.js";

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

interface ChangedFileElement {
  readonly kind: "file";
  readonly file: ReviewDiffFileWire;
  readonly name: string;
}

interface ChangedFolderElement {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: ChangedTreeElement[];
}

type ChangedTreeElement = ChangedFileElement | ChangedFolderElement;

interface MutableFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, MutableFolder>;
  readonly files: ChangedFileElement[];
}

interface ChangedFilesTreeTemplate {
  readonly row: HTMLElement;
  readonly icon: HTMLElement;
  readonly label: HTMLElement;
}

/** Returns changed files in the same folder-first order that the tree shows. */
export function orderReviewDiffFiles(
  files: readonly ReviewDiffFileWire[],
): readonly ReviewDiffFileWire[] {
  const ordered: ReviewDiffFileWire[] = [];
  collectFiles(buildTree(files), ordered);
  return ordered;
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

class ChangedFilesTreeRenderer
  implements
    ICompressibleTreeRenderer<
      ChangedTreeElement,
      void,
      ChangedFilesTreeTemplate
    >
{
  static readonly TEMPLATE_ID = "review.changedFiles.entry";
  readonly templateId = ChangedFilesTreeRenderer.TEMPLATE_ID;

  renderTemplate(container: HTMLElement): ChangedFilesTreeTemplate {
    const row = append(container, $(".review-changed-files-row"));
    const icon = append(row, $("span.review-changed-files-icon"));
    icon.setAttribute("aria-hidden", "true");
    const label = append(row, $("span.review-changed-files-label"));
    return { row, icon, label };
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
    template.icon.hidden = !isFile;
    template.icon.className = isFile
      ? `review-changed-files-icon review-changed-files-icon-${element.file.status} ${ThemeIcon.asClassName(fileStatusIcon(element.file.status))}`
      : "review-changed-files-icon";
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
  private activePath: string | undefined;
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
    const renderer = new ChangedFilesTreeRenderer();
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

  setActiveFile(path: string | undefined): void {
    this.activePath = path;
    this.syncSelection(path);
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

  private syncSelection(path: string | undefined): void {
    const element = path ? this.fileElements.get(path) : undefined;
    this.syncingActiveFile = true;
    try {
      this.tree.setSelection(element ? [element] : []);
      this.tree.setFocus(element ? [element] : []);
      if (element) this.tree.reveal(element);
    } finally {
      this.syncingActiveFile = false;
    }
  }
}

function fileStatusIcon(status: ReviewDiffFileWire["status"]): ThemeIcon {
  if (status === "added") return Codicon.diffAdded;
  if (status === "deleted") return Codicon.diffRemoved;
  if (status === "renamed") return Codicon.diffRenamed;
  return Codicon.diffModified;
}

function buildTree(
  files: readonly ReviewDiffFileWire[],
): ChangedTreeElement[] {
  const root: MutableFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const name = segments.pop() ?? file.path;
    let folder = root;
    for (const segment of segments) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let child = folder.folders.get(segment);
      if (!child) {
        child = {
          name: segment,
          path,
          folders: new Map(),
          files: [],
        };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push({ kind: "file", file, name });
  }

  return folderChildren(root);
}

function folderChildren(folder: MutableFolder): ChangedTreeElement[] {
  const folders = [...folder.folders.values()]
    .map((child): ChangedFolderElement => ({
      kind: "folder",
      name: child.name,
      path: child.path,
      children: folderChildren(child),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [...folder.files].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return [...folders, ...files];
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

function collectFiles(
  elements: readonly ChangedTreeElement[],
  target: ReviewDiffFileWire[],
): void {
  for (const element of elements) {
    if (element.kind === "file") {
      target.push(element.file);
    } else {
      collectFiles(element.children, target);
    }
  }
}
