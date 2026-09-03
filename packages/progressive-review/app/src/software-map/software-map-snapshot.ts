import type { JsonValue } from "@dev.fast/review-protocol";
import { z } from "zod";

import type { C4LayoutBox } from "./c4-map-flow-types";
import type { C4Projection, ProjectedC4Relationship } from "./c4-projection";
import type {
  NormalizedSoftwareModel,
  SoftwareChangeStatus,
  SoftwareDataStoreKind,
} from "./model";

export type SoftwareMapViewType = "inlineC4";

export type SoftwareMapElementType =
  | "person"
  | "softwareSystem"
  | "container"
  | "dataStore"
  | "dataStoreCollection"
  | "component"
  | "codeElement";

export type SoftwareMapRelationshipKind = "call" | "semantic" | "implied";

export interface SoftwareMapDiffCounts {
  additions: number;
  deletions: number;
}

export interface SoftwareMapCoverageClaim {
  path: string;
  files?: Array<{
    path: string;
    ranges?: Array<{ fromLine: number; toLine: number }>;
  }>;
  globs?: string[];
}

export interface SoftwareMapUnmappedDiffLine {
  kind: "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface SoftwareMapUnmappedDiffHunk {
  startLine: number;
  lines: SoftwareMapUnmappedDiffLine[];
}

export interface SoftwareMapUnmappedDiffFile extends SoftwareMapDiffCounts {
  file: string;
  hunks: SoftwareMapUnmappedDiffHunk[];
}

export interface SoftwareMapUnmappedDiffSummary extends SoftwareMapDiffCounts {
  files: SoftwareMapUnmappedDiffFile[];
}

export interface SoftwareMapChangeSummary extends SoftwareMapDiffCounts {
  changeStatus: SoftwareChangeStatus;
  authoredStatus?: SoftwareChangeStatus;
  unmapped?: SoftwareMapUnmappedDiffSummary;
}

export type SoftwareMapNodeDiffPeek = {
  file: string;
  fromLine: number;
  toLine: number;
  graph: "head" | "base";
};

export interface SoftwareMapNodeSnapshot {
  id: string;
  label: string;
  type: SoftwareMapElementType;
  path?: string;
  description?: string;
  changeStatus?: SoftwareChangeStatus;
  authoredChangeStatus?: SoftwareChangeStatus;
  dataStoreKind?: SoftwareDataStoreKind;
  additions?: number;
  deletions?: number;
  parentId?: string | null;
  file?: string;
  line?: number;
  boundary?: boolean;
  expanded?: boolean;
  expandable?: boolean;
  childCount?: number;
  dataStoreSchemaSections?: SoftwareMapDataStoreSchemaSectionSnapshot[];
}

export function softwareMapNodeDiffPeeks({
  model,
  elementPath,
  changeSummaries,
}: {
  model: NormalizedSoftwareModel;
  elementPath: string;
  changeSummaries: ReadonlyMap<string, SoftwareMapChangeSummary>;
}): SoftwareMapNodeDiffPeek[] {
  const result: SoftwareMapNodeDiffPeek[] = [];
  const seen = new Set<string>();

  const append = (key: string, peek: SoftwareMapNodeDiffPeek) => {
    if (seen.has(key)) return;
    seen.add(key);
    result.push(peek);
  };
  const visit = (path: string) => {
    const element = model.elementsByPath.get(path);
    if (!element) return;
    const summary = changeSummaries.get(path);
    if (element.type === "codeElement" && element.sourceRanges?.length) {
      if (summary?.changeStatus === "unchanged") return;
      const graph = summary?.changeStatus === "removed" ? "base" : "head";
      for (const range of element.sourceRanges) {
        append(
          `range:${graph}:${range.file}:${range.fromLine}-${range.toLine}`,
          { ...range, graph },
        );
      }
      return;
    }

    const coveredDiff = summary?.unmapped;
    if (element.coverage && coveredDiff?.files.length) {
      for (const file of coveredDiff.files) {
        for (const range of softwareMapDiffFileRanges(file)) {
          append(
            `range:${range.graph}:${file.file}:${range.fromLine}-${range.toLine}`,
            {
              file: file.file,
              fromLine: range.fromLine,
              toLine: range.toLine,
              graph: range.graph,
            },
          );
        }
      }
      return;
    }

    for (const childPath of element.children) visit(childPath);
  };

  visit(elementPath);
  return result;
}

function softwareMapDiffFileRanges(file: SoftwareMapUnmappedDiffFile): Array<{
  fromLine: number;
  toLine: number;
  graph: "head" | "base";
}> {
  return file.hunks.map((hunk) => {
    const graph = hunk.lines.some((line) => line.newLine !== null)
      ? "head"
      : "base";
    const lineNumbers = hunk.lines.flatMap((line) => {
      const lineNumber = graph === "base" ? line.oldLine : line.newLine;
      return lineNumber === null ? [] : [lineNumber];
    });
    const hunkLines = lineNumbers.length > 0 ? lineNumbers : [hunk.startLine];
    const fromLine = Math.max(1, Math.min(...hunkLines));
    return {
      fromLine,
      toLine: Math.max(fromLine, ...hunkLines),
      graph,
    };
  });
}

export type SoftwareMapDataStoreSchemaSectionSnapshot = {
  id: string;
  label: string;
  kind: "table" | "document";
  key?: string;
  rows: SoftwareMapDataStoreSchemaRowSnapshot[];
};

export type SoftwareMapDataStoreSchemaRowSnapshot = {
  id: string;
  label: string;
  depth?: number;
  type?: string;
  example?: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
  state?: "active" | "inactive";
};

export interface SoftwareMapRelationshipSnapshot {
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: SoftwareMapRelationshipKind;
  semanticKind?: string;
  hideLabel?: boolean;
  fromSchemaFieldPath?: string[];
  toSchemaFieldPath?: string[];
  fromSchemaEndpointKind?: "field" | "header";
  toSchemaEndpointKind?: "field" | "header";
}

export interface SoftwareMapResolvedSnapshot {
  title?: string;
  view?: string;
  viewType?: SoftwareMapViewType;
  nodes?: SoftwareMapNodeSnapshot[];
  relationships?: SoftwareMapRelationshipSnapshot[];
  selectedNodeId?: string | null;
  status?: string | null;
  unmappedDiff?: SoftwareMapUnmappedDiffSummary;
  groupBboxes?: Record<string, C4LayoutBox>;
}

export interface SoftwareMapResolvedDataState {
  key: string;
  counts: ReadonlyMap<string, SoftwareMapDiffCounts>;
  unmappedByElementPath: ReadonlyMap<string, SoftwareMapUnmappedDiffSummary>;
}

export type SoftwareMapResolvedDataPayload = Omit<
  SoftwareMapResolvedDataState,
  "key"
>;

export function c4DisplayedSnapshotForCurrentState(
  layoutSnapshot: SoftwareMapResolvedSnapshot,
  currentSnapshot: SoftwareMapResolvedSnapshot,
): SoftwareMapResolvedSnapshot {
  const layoutNodes = layoutSnapshot.nodes ?? [];
  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const currentSelectedNodeId =
    currentSnapshot.selectedNodeId &&
    layoutNodeIds.has(currentSnapshot.selectedNodeId)
      ? currentSnapshot.selectedNodeId
      : null;
  const layoutSelectedNodeId =
    layoutSnapshot.selectedNodeId &&
    layoutNodeIds.has(layoutSnapshot.selectedNodeId)
      ? layoutSnapshot.selectedNodeId
      : null;

  return {
    ...layoutSnapshot,
    selectedNodeId: currentSelectedNodeId ?? layoutSelectedNodeId,
    status: currentSnapshot.status ?? layoutSnapshot.status,
    unmappedDiff: currentSnapshot.unmappedDiff,
  };
}

export function buildSoftwareMapChangeSummaries(
  model: NormalizedSoftwareModel,
  diffCounts: ReadonlyMap<string, SoftwareMapDiffCounts> = new Map(),
  unmappedByElementPath: ReadonlyMap<
    string,
    SoftwareMapUnmappedDiffSummary
  > = new Map(),
): ReadonlyMap<string, SoftwareMapChangeSummary> {
  const summaries = new Map<string, SoftwareMapChangeSummary>();

  const summarize = (path: string): SoftwareMapChangeSummary => {
    const cached = summaries.get(path);
    if (cached) return cached;

    const element = model.elementsByPath.get(path);
    const ownCounts = diffCounts.get(path) ?? { additions: 0, deletions: 0 };
    const ownUnmapped = unmappedByElementPath.get(path);
    const hasOwnCoverage = Boolean(element?.coverage);
    let additions =
      element?.type === "codeElement"
        ? ownCounts.additions
        : (ownUnmapped?.additions ?? 0);
    let deletions =
      element?.type === "codeElement"
        ? ownCounts.deletions
        : (ownUnmapped?.deletions ?? 0);
    const changedDescendantStatuses: SoftwareChangeStatus[] = [];

    for (const childPath of element?.children ?? []) {
      const child = summarize(childPath);
      const childElement = model.elementsByPath.get(childPath);
      if (!hasOwnCoverage && childElement?.type !== "codeElement") {
        additions += child.additions;
        deletions += child.deletions;
      }
      if (child.changeStatus !== "unchanged") {
        changedDescendantStatuses.push(child.changeStatus);
      }
    }

    const authoredStatus = element?.changeStatus;
    const changeStatus = inferSoftwareMapChangeStatus({
      authoredStatus,
      additions,
      deletions,
      changedDescendantStatuses,
    });
    const summary: SoftwareMapChangeSummary = {
      changeStatus,
      authoredStatus,
      additions,
      deletions,
      unmapped: ownUnmapped,
    };
    summaries.set(path, summary);
    return summary;
  };

  for (const element of model.elements) {
    summarize(element.path);
  }
  return summaries;
}

function inferSoftwareMapChangeStatus({
  authoredStatus,
  additions,
  deletions,
  changedDescendantStatuses,
}: {
  authoredStatus?: SoftwareChangeStatus;
  additions: number;
  deletions: number;
  changedDescendantStatuses: readonly SoftwareChangeStatus[];
}): SoftwareChangeStatus {
  if (authoredStatus === "added" || authoredStatus === "removed") {
    return authoredStatus;
  }

  if (additions > 0 || deletions > 0) {
    return "modified";
  }

  if (authoredStatus === "modified") return authoredStatus;

  if (changedDescendantStatuses.length > 0) {
    return "modified";
  }

  return "unchanged";
}

const softwareMapDiffCountsSchema = z.object({
  additions: z.number(),
  deletions: z.number(),
});

const softwareMapUnmappedDiffSummarySchema = softwareMapDiffCountsSchema.extend(
  {
    files: z.array(
      softwareMapDiffCountsSchema.extend({
        file: z.string(),
        hunks: z.array(
          z.object({
            startLine: z.number(),
            lines: z.array(
              z.object({
                kind: z.enum(["add", "remove"]),
                oldLine: z.number().nullable(),
                newLine: z.number().nullable(),
                text: z.string(),
              }),
            ),
          }),
        ),
      }),
    ),
  },
);

/** The `ok` body of the resolved-data route; any other body yields no data. */
const softwareMapResolvedDataResponseSchema = z.object({
  ok: z.literal(true),
  countsByElementPath: z
    .record(z.string(), softwareMapDiffCountsSchema)
    .optional(),
  unmappedByElementPath: z
    .record(z.string(), softwareMapUnmappedDiffSummarySchema)
    .optional(),
});

export function parseSoftwareMapResolvedDataResponse(
  json: JsonValue,
): SoftwareMapResolvedDataPayload {
  const body = softwareMapResolvedDataResponseSchema.safeParse(json);
  if (!body.success) {
    return {
      counts: new Map(),
      unmappedByElementPath: new Map(),
    };
  }
  return {
    counts: new Map(Object.entries(body.data.countsByElementPath ?? {})),
    unmappedByElementPath: new Map(
      Object.entries(body.data.unmappedByElementPath ?? {}),
    ),
  };
}

export function softwareMapSnapshotFromInlineC4Projection({
  projection,
  changeSummaries,
}: {
  projection: C4Projection;
  changeSummaries?: ReadonlyMap<string, SoftwareMapChangeSummary>;
}): SoftwareMapResolvedSnapshot {
  const selectedNodeId = projection.selectedNodeId ?? projection.nodes[0]?.id;
  const selectedNode = selectedNodeId
    ? projection.nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  return {
    title: "Software map",
    view: "inline-c4",
    viewType: "inlineC4",
    selectedNodeId,
    unmappedDiff: selectedNode
      ? changeSummaries?.get(selectedNode.path)?.unmapped
      : undefined,
    nodes: projection.nodes.map((element) => {
      const summary = changeSummaries?.get(element.path);
      return {
        id: element.id,
        label: element.label,
        type: element.type,
        path: element.path,
        description: element.description,
        changeStatus: summary?.changeStatus ?? element.changeStatus,
        authoredChangeStatus: element.changeStatus,
        dataStoreKind: element.dataStoreKind,
        additions: summary?.additions,
        deletions: summary?.deletions,
        parentId: element.parentPath ?? null,
        file: element.element?.sourceRanges?.[0]?.file,
        line: element.element?.sourceRanges?.[0]?.fromLine,
        boundary: element.external,
        expanded: element.isExpanded,
        expandable: element.isExpandable,
        childCount: element.childCount,
        dataStoreSchemaSections: element.dataStoreSchemaSections,
      };
    }),
    relationships: projection.relationships.map((relationship) =>
      softwareMapRelationshipFromInlineC4Relationship(relationship),
    ),
    status: null,
  };
}

function softwareMapRelationshipFromInlineC4Relationship(
  relationship: ProjectedC4Relationship,
): SoftwareMapRelationshipSnapshot {
  return {
    id: relationship.id,
    from: relationship.from,
    to: relationship.to,
    label: relationship.count > 1 ? undefined : relationship.label,
    semanticKind: relationship.semanticKind,
    kind: relationship.kind,
    hideLabel: relationship.hideLabel,
    fromSchemaFieldPath: relationship.fromSchemaFieldPath,
    toSchemaFieldPath: relationship.toSchemaFieldPath,
    fromSchemaEndpointKind: relationship.fromSchemaEndpointKind,
    toSchemaEndpointKind: relationship.toSchemaEndpointKind,
  };
}

export function c4FinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

export function visibleSoftwareMapChangeCount(count?: number) {
  return count !== undefined && c4FinitePositive(count) ? count : 0;
}
