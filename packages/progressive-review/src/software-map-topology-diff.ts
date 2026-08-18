import type {
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
  NormalizedSoftwareRelationship,
  SoftwareChangeStatus,
} from "./software-map-model";

export interface SoftwareMapElementTopologyChange {
  path: string;
  status: Exclude<SoftwareChangeStatus, "unchanged">;
  label: string;
  type: NormalizedSoftwareElement["type"];
  beforeParentPath?: string;
  afterParentPath?: string;
}

export interface SoftwareMapRelationshipTopologyChange {
  key: string;
  status: Exclude<SoftwareChangeStatus, "unchanged">;
  from: string;
  to: string;
  kind: NormalizedSoftwareRelationship["kind"];
  label?: string;
}

export interface SoftwareMapTopologyDiff {
  elementChanges: SoftwareMapElementTopologyChange[];
  relationshipChanges: SoftwareMapRelationshipTopologyChange[];
  elementStatusByPath: Record<
    string,
    Exclude<SoftwareChangeStatus, "unchanged">
  >;
  counts: {
    addedElements: number;
    removedElements: number;
    modifiedElements: number;
    addedRelationships: number;
    removedRelationships: number;
    modifiedRelationships: number;
  };
}

export function diffSoftwareMaps(
  base: NormalizedSoftwareModel | null | undefined,
  head: NormalizedSoftwareModel | null | undefined,
): SoftwareMapTopologyDiff | null {
  if (!base || !head) return null;

  const elementChanges = diffElements(base, head);
  const relationshipChanges = diffRelationships(base, head);
  const elementStatusByPath = Object.fromEntries(
    elementChanges
      .filter((change) => change.status !== "removed")
      .map((change) => [change.path, change.status]),
  ) as Record<string, Exclude<SoftwareChangeStatus, "unchanged">>;

  return {
    elementChanges,
    relationshipChanges,
    elementStatusByPath,
    counts: {
      addedElements: elementChanges.filter(
        (change) => change.status === "added",
      ).length,
      removedElements: elementChanges.filter(
        (change) => change.status === "removed",
      ).length,
      modifiedElements: elementChanges.filter(
        (change) => change.status === "modified",
      ).length,
      addedRelationships: relationshipChanges.filter(
        (change) => change.status === "added",
      ).length,
      removedRelationships: relationshipChanges.filter(
        (change) => change.status === "removed",
      ).length,
      modifiedRelationships: relationshipChanges.filter(
        (change) => change.status === "modified",
      ).length,
    },
  };
}

function diffElements(
  base: NormalizedSoftwareModel,
  head: NormalizedSoftwareModel,
): SoftwareMapElementTopologyChange[] {
  const changes: SoftwareMapElementTopologyChange[] = [];
  const baseByPath = base.elementsByPath;
  const headByPath = head.elementsByPath;

  for (const headElement of head.elements) {
    const baseElement = baseByPath.get(headElement.path);
    if (!baseElement) {
      changes.push(elementChange(headElement, "added"));
      continue;
    }
    if (
      elementTopologySignature(baseElement) !==
      elementTopologySignature(headElement)
    ) {
      changes.push(
        elementChange(headElement, "modified", {
          beforeParentPath: baseElement.parentPath,
          afterParentPath: headElement.parentPath,
        }),
      );
    }
  }

  for (const baseElement of base.elements) {
    if (!headByPath.has(baseElement.path)) {
      changes.push(elementChange(baseElement, "removed"));
    }
  }

  return changes.sort(compareElementChanges);
}

function elementChange(
  element: NormalizedSoftwareElement,
  status: Exclude<SoftwareChangeStatus, "unchanged">,
  extra: Partial<SoftwareMapElementTopologyChange> = {},
): SoftwareMapElementTopologyChange {
  return {
    path: element.path,
    status,
    label: element.label,
    type: element.type,
    ...extra,
  };
}

function elementTopologySignature(element: NormalizedSoftwareElement): string {
  return JSON.stringify({
    type: element.type,
    label: element.label,
    parentPath: element.parentPath ?? null,
    external: element.external ?? null,
    coverage: element.coverage ?? null,
    sourceRanges: element.sourceRanges ?? null,
  });
}

function diffRelationships(
  base: NormalizedSoftwareModel,
  head: NormalizedSoftwareModel,
): SoftwareMapRelationshipTopologyChange[] {
  const changes: SoftwareMapRelationshipTopologyChange[] = [];
  const baseByKey = relationshipMap(base.relationships);
  const headByKey = relationshipMap(head.relationships);

  for (const [key, headRelationship] of headByKey) {
    const baseRelationship = baseByKey.get(key);
    if (!baseRelationship) {
      changes.push(relationshipChange(key, headRelationship, "added"));
      continue;
    }
    if (
      relationshipTopologySignature(baseRelationship) !==
      relationshipTopologySignature(headRelationship)
    ) {
      changes.push(relationshipChange(key, headRelationship, "modified"));
    }
  }

  for (const [key, baseRelationship] of baseByKey) {
    if (!headByKey.has(key)) {
      changes.push(relationshipChange(key, baseRelationship, "removed"));
    }
  }

  return changes.sort(compareRelationshipChanges);
}

function relationshipMap(
  relationships: readonly NormalizedSoftwareRelationship[],
): Map<string, NormalizedSoftwareRelationship> {
  return new Map(
    relationships.map((relationship) => [
      relationshipTopologyKey(relationship),
      relationship,
    ]),
  );
}

function relationshipTopologyKey(
  relationship: NormalizedSoftwareRelationship,
): string {
  return [
    relationship.from,
    relationship.to,
    relationship.kind,
    relationship.kind === "semantic" ? (relationship.semanticKind ?? "") : "",
    relationship.kind === "call" ? String(relationship.nthCallSite) : "",
  ].join("\u0000");
}

function relationshipTopologySignature(
  relationship: NormalizedSoftwareRelationship,
): string {
  return JSON.stringify({
    label: relationship.label ?? null,
    description: relationship.description ?? null,
    sourceRanges:
      relationship.kind === "semantic"
        ? (relationship.sourceRanges ?? null)
        : null,
  });
}

function relationshipChange(
  key: string,
  relationship: NormalizedSoftwareRelationship,
  status: Exclude<SoftwareChangeStatus, "unchanged">,
): SoftwareMapRelationshipTopologyChange {
  return {
    key,
    status,
    from: relationship.from,
    to: relationship.to,
    kind: relationship.kind,
    label: relationship.label,
  };
}

function compareElementChanges(
  left: SoftwareMapElementTopologyChange,
  right: SoftwareMapElementTopologyChange,
) {
  return (
    statusOrder(left.status) - statusOrder(right.status) ||
    left.path.localeCompare(right.path)
  );
}

function compareRelationshipChanges(
  left: SoftwareMapRelationshipTopologyChange,
  right: SoftwareMapRelationshipTopologyChange,
) {
  return (
    statusOrder(left.status) - statusOrder(right.status) ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.key.localeCompare(right.key)
  );
}

function statusOrder(status: Exclude<SoftwareChangeStatus, "unchanged">) {
  if (status === "added") return 0;
  if (status === "modified") return 1;
  return 2;
}
