import type { FileLineRange } from "../source.js";
import type { FileLensBlock } from "./blocks/file_lens.js";
import { type Block, elements } from "./document.js";

/** A lens the Diff view lists: a named set of changed lines. */
export interface DiffLens {
  id: string;
  title: string;
  sources: FileLineRange[];
  fileCount?: number;
  wholeFiles?: boolean;
}

/** The Diff view's lenses are the document's file lenses and nothing else;
 * diagrams stay in the document. */
export function documentFileLenses(document: Block[]): FileLensBlock[] {
  return elements(document).filter(
    (block): block is FileLensBlock => block.type === "file_lens",
  );
}
