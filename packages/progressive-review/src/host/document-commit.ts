import {
  type HostDocumentCommit,
  type HostDocumentState,
  type JsonValue,
  canonicalHostJson,
} from "@dev.fast/review-protocol";

function changes<T extends JsonValue>(
  before: Record<string, T>,
  after: Record<string, T>,
) {
  return {
    changed: Object.fromEntries(
      Object.entries(after).filter(
        ([id, value]) =>
          !Object.hasOwn(before, id) ||
          canonicalHostJson(before[id]!) !== canonicalHostJson(value),
      ),
    ),
    removed: Object.keys(before).filter((id) => !Object.hasOwn(after, id)),
  };
}

/** The response and committed event describe exactly the same atomic change. */
export function documentCommit(
  before: HostDocumentState,
  after: HostDocumentState,
): HostDocumentCommit {
  const nodes = changes(before.nodes, after.nodes);
  const definitions = changes(before.definitions, after.definitions);
  const evidence = changes(before.evidence, after.evidence);
  return {
    documentId: after.documentId,
    previousVersion: before.version,
    version: after.version,
    contentHash: after.contentHash,
    createdAt: after.createdAt,
    changedNodes: nodes.changed,
    removedNodeIds: nodes.removed,
    changedDefinitions: definitions.changed,
    removedDefinitionIds: definitions.removed,
    changedEvidence: evidence.changed,
    removedEvidenceIds: evidence.removed,
    roots: after.roots,
    binding: after.binding,
    diagnostics: [],
  };
}
