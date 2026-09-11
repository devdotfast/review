import {
  type HostBinding,
  type HostDefinition,
  type HostDiagnostic,
  type HostDocumentState,
  type HostSourceRange,
} from "@dev.fast/review-protocol";

import { mapCodeSpanThroughHunks } from "../review-code-target-remap";
import { EvidenceProviderError } from "./evidence-provider";
import type {
  LocalRepositorySource,
  LocalSourceDiffFile,
} from "./local-repository";

export interface HostAnchorRepinProposal {
  id: string;
  before: HostSourceRange;
  proposed: HostSourceRange | null;
  status: "exact" | "relocated" | "missing";
}

export interface HostDocumentRepinProposal {
  basedOnDocumentVersion: number;
  binding: HostBinding;
  anchorChanges: HostAnchorRepinProposal[];
  proposedDefinitions: Record<string, HostDefinition>;
  diagnostics: HostDiagnostic[];
}

/** A proposal only: accepted versions and original comment targets never change.
 * The service must still apply explicit corrections and validate new evidence
 * atomically against basedOnDocumentVersion before accepting these definitions. */
export async function proposeDocumentRepin(input: {
  document: HostDocumentState;
  binding: HostBinding;
  source: LocalRepositorySource;
}): Promise<HostDocumentRepinProposal> {
  const { document, binding, source } = input;
  if (document.binding.repositoryId !== binding.repositoryId) {
    throw new EvidenceProviderError(
      "INVALID_REQUEST",
      "A review cannot be repinned to a different repository.",
    );
  }
  const proposal: HostDocumentRepinProposal = {
    basedOnDocumentVersion: document.reviewVersion,
    binding: structuredClone(binding),
    anchorChanges: [],
    proposedDefinitions: {},
    diagnostics: [],
  };
  const transitions = new Map<
    "base" | "head",
    { binding: HostBinding; files: LocalSourceDiffFile[] }
  >();
  for (const [id, definition] of Object.entries(document.definitions)) {
    if (definition.kind !== "anchor") continue;
    const before = { ...definition.source };
    const oldCommit =
      before.side === "base"
        ? document.binding.baseCommit
        : document.binding.headCommit;
    const newCommit =
      before.side === "base" ? binding.baseCommit : binding.headCommit;
    let proposed: HostSourceRange | null = { ...before };
    if (oldCommit !== newCommit) {
      let transition = transitions.get(before.side);
      if (!transition) {
        const pins = {
          ...binding,
          baseCommit: oldCommit,
          headCommit: newCommit,
        };
        transition = { binding: pins, files: await source.diffFiles(pins) };
        transitions.set(before.side, transition);
      }
      const file = transition.files.find(
        (entry) => (entry.previousPath ?? entry.path) === before.file,
      );
      if (file) {
        if (file.status === "deleted" || file.binary) proposed = null;
        else {
          const mapped = mapCodeSpanThroughHunks(
            { startLine: before.fromLine, endLine: before.toLine },
            await source.diffHunks(transition.binding, before.file, "base"),
          );
          proposed = mapped
            ? {
                ...before,
                file: file.path,
                fromLine: mapped.startLine,
                toLine: mapped.endLine,
              }
            : null;
        }
      }
    }
    const status =
      proposed === null
        ? "missing"
        : proposed.file === before.file &&
            proposed.fromLine === before.fromLine &&
            proposed.toLine === before.toLine
          ? "exact"
          : "relocated";
    proposal.anchorChanges.push({ id, before, proposed, status });
    if (proposed)
      proposal.proposedDefinitions[id] = {
        ...definition,
        source: { ...proposed },
      };
    else
      proposal.diagnostics.push({
        severity: "error",
        code: "ANCHOR_REPIN_REQUIRED",
        definitionId: id,
        path: `/definitions/${id}/source`,
        message:
          "This source range was removed, changed, or no longer remains contiguous. Supply an explicit replacement or remove its consumers before applying the repin.",
      });
  }
  return proposal;
}
