import type { ReviewDiffFileWire } from "./reviewProtocol.js";

export interface ChangedFileElement {
  readonly kind: "file";
  readonly file: ReviewDiffFileWire;
  readonly name: string;
}

export interface ChangedFolderElement {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: ChangedTreeElement[];
}

export type ChangedTreeElement = ChangedFileElement | ChangedFolderElement;

interface MutableFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, MutableFolder>;
  readonly files: ChangedFileElement[];
}

/** Returns changed files in the same folder-first order that the tree shows. */
export function orderReviewDiffFiles(
  files: readonly ReviewDiffFileWire[],
): readonly ReviewDiffFileWire[] {
  const ordered: ReviewDiffFileWire[] = [];
  collectFiles(buildTree(files), ordered);
  return ordered;
}

export function buildTree(
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
