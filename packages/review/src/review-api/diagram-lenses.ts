import type { ReviewDiffLens } from "@dev.fast/review-protocol";

import type { LensSource } from "../lens-selection.js";
import {
  type Block,
  type FileLineRange,
  elements,
  lensSourceReferences,
} from "./document.js";

export interface DiagramLens {
  id: string;
  title: string;
  kind: string;
  sources: FileLineRange[];
  fileCount?: number;
  wholeFiles?: boolean;
}

/** Derived from saved content; there is no second authored lens manifest. */
export function diagramLenses(
  document: Block[],
): (Omit<DiagramLens, "sources"> & { sources: LensSource[] })[] {
  return elements(document).flatMap(
    (block): (Omit<DiagramLens, "sources"> & { sources: LensSource[] })[] => {
      if (
        block.type !== "file_lens" &&
        block.type !== "software_map" &&
        block.type !== "sequence" &&
        block.type !== "call_stack_diff" &&
        block.type !== "database_lens"
      )
        return [];

      return [
        {
          id: block.id!,
          title: block.type === "software_map" ? "Software map" : block.title,
          kind: block.type,
          sources: lensSourceReferences([block]).map((ref) => ref.source),
        },
      ];
    },
  );
}

export function nativeLens(
  lens: DiagramLens,
  reviewId: string,
  version: number,
): ReviewDiffLens {
  return {
    id: lens.id,
    title: lens.title,
    reviewId,
    version,
    ranges: lens.sources,
    wholeFiles: lens.wholeFiles ?? false,
  };
}
