import type {
  ReviewDiffLens,
  ReviewDiffLensTarget,
} from "@dev.fast/review-protocol";

import { evidenceTargets } from "../source.js";
import {
  type Block,
  type Source,
  elements,
  sourceReferences,
  evidenceReferences,
} from "./document.js";

export interface DiagramLens {
  id: string;
  title: string;
  kind: string;
  sources: Source[];
  targets: ReviewDiffLensTarget[];
  fileCount?: number;
  wholeFiles?: boolean;
}

/** Derived from saved content; there is no second authored lens manifest. */
export function diagramLenses(document: Block[]): DiagramLens[] {
  return elements(document).flatMap((block): DiagramLens[] => {
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
        targets: evidenceTargets(
          evidenceReferences([block]).map((ref) => ref.source),
        ),
        sources: sourceReferences([block]).map((ref) => ref.source),
      },
    ];
  });
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
    targets: lens.targets,
    wholeFiles: lens.wholeFiles ?? false,
  };
}
