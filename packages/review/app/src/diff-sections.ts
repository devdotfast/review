import type { Block } from "../../src/review-api/document";
import { evidenceSources, type Source } from "../../src/source";
import { callTreeStops } from "./call-tree";

/** The same scope drives diagram navigation, diff boundaries and viewed actions. */
export interface DiffSection {
  id: string;
  label: string;
  sources: Source[];
}

export function diffSections(block: Block | undefined): DiffSection[] {
  if (!block) return [];

  if (block.type === "sequence")
    return block.steps.flatMap((step, index) =>
      step.source
        ? [
            {
              id: step.id ?? `${block.id}:${index}`,
              label: step.label,
              sources: evidenceSources(step.source),
            },
          ]
        : [],
    );

  if (block.type === "call_stack_diff") return callTreeStops(block);

  if (block.type === "database_lens")
    return block.useCases.flatMap((useCase) =>
      useCase.operations.map((operation, index) => ({
        id: operation.id ?? `${useCase.id}:${index}`,
        label: operation.label,
        sources: evidenceSources(operation.source),
      })),
    );

  return [];
}
