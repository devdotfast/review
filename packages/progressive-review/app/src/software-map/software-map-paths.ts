import { throwAuthoringIssue } from "../../../src/authoring";
import { buildGraphTarget } from "../target-fingerprint";
import type { LiveDiagramTarget } from "../thread-target-state";
import type {
  SoftwareMapNodeSnapshot,
  SoftwareMapRelationshipSnapshot,
  SoftwareMapResolvedSnapshot,
} from "./software-map-snapshot";

function relationshipEndpointsKey(relationship: { from: string; to: string }) {
  return `${relationship.from}\u0000${relationship.to}`;
}

export function softwareMapNodeLabelPath(
  node: SoftwareMapNodeSnapshot,
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>,
): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let current: SoftwareMapNodeSnapshot | undefined = node;
  while (current) {
    if (visited.has(current.id)) {
      throw new Error(
        `Software map node ancestry contains a cycle at ${current.id}.`,
      );
    }
    visited.add(current.id);
    path.unshift(current.label);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return path;
}

export function softwareMapLiveDiagram(
  label: string,
  viewName: string,
  snapshot: SoftwareMapResolvedSnapshot,
): LiveDiagramTarget {
  const nodes = snapshot.nodes ?? [];
  const relationships = snapshot.relationships ?? [];
  validateSoftwareMapTargetPaths(label, nodes, relationships);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const viewType = snapshot.viewType ?? "inlineC4";
  const elements: LiveDiagramTarget["elements"] = [
    buildGraphTarget({
      diagram: label,
      type: "node",
      path: [label],
      payload: { title: label, viewName, viewType },
      quote: label,
    }),
    ...nodes.map((node) =>
      buildGraphTarget({
        diagram: label,
        type: "node",
        path: softwareMapNodeLabelPath(node, nodesById),
        payload: softwareMapNodeTargetPayload(node),
        quote: node.label,
      }),
    ),
    ...relationships.map((relationship) =>
      buildGraphTarget({
        diagram: label,
        type: "edge",
        path: softwareMapRelationshipLabelPath(
          relationship,
          relationships,
          nodesById,
        ),
        payload: softwareMapRelationshipTargetPayload(relationship),
        quote:
          (relationship.hideLabel
            ? undefined
            : (relationship.label ?? relationship.semanticKind)) ??
          relationship.id ??
          `${relationship.from}→${relationship.to}`,
      }),
    ),
  ];
  validateGraphElementPaths(label, elements);
  return { label, elements };
}

export function softwareMapNodeTargetPayload(node: SoftwareMapNodeSnapshot) {
  return {
    label: node.label,
    type: node.type,
    description: node.description,
    changeStatus: node.changeStatus,
    authoredChangeStatus: node.authoredChangeStatus,
    dataStoreKind: node.dataStoreKind,
    additions: node.additions,
    deletions: node.deletions,
    file: node.file,
    line: node.line,
    boundary: node.boundary,
    expandable: node.expandable,
    childCount: node.childCount,
    dataStoreSchemaSections: node.dataStoreSchemaSections,
  };
}

export function softwareMapRelationshipTargetPayload(
  relationship: SoftwareMapRelationshipSnapshot,
) {
  return {
    label: relationship.label,
    kind: relationship.kind,
    semanticKind: relationship.semanticKind,
    hideLabel: relationship.hideLabel,
    fromSchemaFieldPath: relationship.fromSchemaFieldPath,
    toSchemaFieldPath: relationship.toSchemaFieldPath,
    fromSchemaEndpointKind: relationship.fromSchemaEndpointKind,
    toSchemaEndpointKind: relationship.toSchemaEndpointKind,
  };
}

function validateSoftwareMapTargetPaths(
  diagram: string,
  nodes: readonly SoftwareMapNodeSnapshot[],
  relationships: readonly SoftwareMapRelationshipSnapshot[],
): void {
  const siblingLabels = new Map<string, Set<string>>();
  for (const node of nodes) {
    const parent = node.parentId ?? "<root>";
    const labels = siblingLabels.get(parent) ?? new Set<string>();
    if (labels.has(node.label)) {
      throwAuthoringIssue(
        ["model", "elements"],
        `SoftwareMap "${diagram}" has sibling elements labelled "${node.label}"`,
      );
    }
    labels.add(node.label);
    siblingLabels.set(parent, labels);
  }

  // Parallel means the same endpoint identities (node ids), not the same
  // endpoint display labels: same-named elements under different parents are
  // legal, so label-aliased edges between distinct pairs are not parallel.
  // Parallel edges are distinguished by label when present, falling back to
  // relationship kind: the inline C4 projection legitimately aggregates
  // same-kind edges into one unlabelled edge per kind for a pair.
  const edgeDiscriminators = new Map<string, Set<string>>();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const parallelCounts = new Map<string, number>();
  for (const relationship of relationships) {
    const key = relationshipEndpointsKey(relationship);
    parallelCounts.set(key, (parallelCounts.get(key) ?? 0) + 1);
  }
  for (const [index, relationship] of relationships.entries()) {
    const key = relationshipEndpointsKey(relationship);
    const discriminators = edgeDiscriminators.get(key) ?? new Set<string>();
    const discriminator = relationshipParallelDiscriminator(relationship);
    if (
      (parallelCounts.get(key) ?? 0) > 1 &&
      discriminators.has(discriminator)
    ) {
      const from = nodesById.get(relationship.from)?.label ?? relationship.from;
      const to = nodesById.get(relationship.to)?.label ?? relationship.to;
      throwAuthoringIssue(
        ["model", "relationships", index, "label"],
        `Label must be unique among parallel ${from}→${to} relationships`,
      );
    }
    discriminators.add(discriminator);
    edgeDiscriminators.set(key, discriminators);
  }
}

// The discriminator that keeps parallel relationships between the same
// endpoints apart in comment target paths: the label when authored or
// derived, otherwise the relationship kind (unlabelled edges of different
// kinds between one pair are legal projection output).
function relationshipParallelDiscriminator(
  relationship: SoftwareMapRelationshipSnapshot,
): string {
  const label = relationship.label?.trim();
  if (label) return label;
  const kind =
    relationship.kind === "semantic" && relationship.semanticKind
      ? `${relationship.kind}: ${relationship.semanticKind}`
      : (relationship.kind ?? "relationship");
  return `(${kind})`;
}

function validateGraphElementPaths(
  diagram: string,
  elements: LiveDiagramTarget["elements"],
): void {
  const paths = new Set<string>();
  for (const element of elements) {
    const key = `${element.element.type}\u0000${element.element.path.join("\u0000")}`;
    if (paths.has(key)) {
      throwAuthoringIssue(
        ["model"],
        `SoftwareMap "${diagram}" has an ambiguous ${element.element.type} path ${element.element.path.join(" / ")}`,
      );
    }
    paths.add(key);
  }
}

export function softwareMapRelationshipLabelPath(
  relationship: SoftwareMapRelationshipSnapshot,
  relationships: readonly SoftwareMapRelationshipSnapshot[],
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>,
): string[] {
  const endpointLabel = (nodeId: string) =>
    nodesById.get(nodeId)?.label ?? nodeId;
  const segmentFor = (candidate: { from: string; to: string }) =>
    `${endpointLabel(candidate.from)}→${endpointLabel(candidate.to)}`;
  const segment = segmentFor(relationship);
  const identityKey = relationshipEndpointsKey(relationship);
  const endpointPairsForSegment = new Set<string>();
  let parallelCount = 0;
  for (const candidate of relationships) {
    if (segmentFor(candidate) !== segment) continue;
    const candidateKey = relationshipEndpointsKey(candidate);
    endpointPairsForSegment.add(candidateKey);
    if (candidateKey === identityKey) parallelCount += 1;
  }
  // Distinct endpoint pairs can share a segment when same-named elements live
  // under different parents; qualify with the full node label paths so edge
  // paths stay unique.
  const qualifiedSegment =
    endpointPairsForSegment.size > 1
      ? `${endpointLabelPath(relationship.from, nodesById)}→${endpointLabelPath(relationship.to, nodesById)}`
      : segment;
  if (parallelCount <= 1) return [qualifiedSegment];
  return [qualifiedSegment, relationshipParallelDiscriminator(relationship)];
}

function endpointLabelPath(
  nodeId: string,
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>,
): string {
  const node = nodesById.get(nodeId);
  if (!node) return nodeId;
  return softwareMapNodeLabelPath(node, nodesById).join(".");
}
