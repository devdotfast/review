import type {
  HostDocumentState,
  HostMapVersion,
  HostNode,
} from "@dev.fast/review-protocol";
import { expect, it } from "vitest";

import {
  hostDatabaseSnapshot,
  hostMapSnapshot,
} from "./host-document-components";
import { runInlineC4Layout } from "./software-map/c4-layout-geometry";

const commit = "a".repeat(40);
const hash = "b".repeat(64);
const timestamp = "2026-09-10T00:00:00Z";

it("lays out real C4 database edges with repeated labels and shared source evidence", async () => {
  const node: Extract<HostNode, { type: "database_lens" }> = {
    id: "database-view",
    type: "database_lens",
    title: "Storage",
    storeIds: ["store"],
    useCases: [
      {
        id: "case",
        label: "Access",
        operations: [
          {
            id: "read",
            kind: "read",
            actorId: "worker",
            store: { storeId: "store", collectionId: "records", fieldId: "id" },
            label: "Access",
            anchorId: "source",
          },
          {
            id: "write",
            kind: "write",
            actorId: "worker",
            store: { storeId: "store", collectionId: "records", fieldId: "id" },
            label: "Access",
            anchorId: "source",
          },
        ],
      },
    ],
  };
  const document: HostDocumentState = {
    schemaVersion: 1,
    documentId: "document",
    reviewId: "review",
    version: 1,
    contentHash: hash,
    createdAt: timestamp,
    roots: [node.id],
    nodes: { [node.id]: node },
    binding: {
      id: "binding",
      repositoryId: "repository",
      selector: { kind: "snapshot", ref: commit },
      baseCommit: commit,
      headCommit: commit,
      createdAt: timestamp,
    },
    definitions: {
      worker: { kind: "actor", label: "Worker" },
      source: {
        kind: "anchor",
        title: "Source",
        source: { side: "head", file: "main.ts", fromLine: 1, toLine: 1 },
      },
      store: {
        kind: "store",
        label: "Records",
        storage: "relational",
        collections: {
          records: {
            label: "Records",
            fields: {
              id: {
                label: "ID",
                dataType: "integer",
                nullable: false,
                primaryKey: true,
              },
            },
          },
        },
      },
    },
    evidence: {
      source: {
        span: {
          repositoryId: "repository",
          commit,
          blob: commit,
          file: "main.ts",
          fromLine: 1,
          toLine: 1,
        },
        text: "return records;",
        sha256: hash,
      },
    },
  };
  const snapshot = hostDatabaseSnapshot(node, document);
  const { layout } = await runInlineC4Layout(
    snapshot.nodes!,
    snapshot.relationships!,
  );
  expect(layout.nodes.map((item) => item.node.id).sort()).toEqual([
    "store",
    "worker",
  ]);
  for (const id of ["read", "write"]) {
    const segments = layout.edgeSections.get(id);
    expect(segments?.length).toBeGreaterThan(0);
    expect(
      segments?.every(
        (segment) =>
          Number.isFinite(segment.startPoint.x) &&
          Number.isFinite(segment.endPoint.y),
      ),
    ).toBe(true);
  }
});

it("lays out an exact nested map and maintains its routing after collapsing the boundary", async () => {
  const map: HostMapVersion = {
    schemaVersion: 1,
    id: "map-version",
    mapId: "map",
    repositoryId: "repository",
    commit,
    contentHash: hash,
    createdAt: timestamp,
    revision: 1,
    elements: {
      service: {
        id: "service",
        parentId: null,
        kind: "system",
        label: "Service",
        description: "",
        source: [],
      },
      worker: {
        id: "worker",
        parentId: "service",
        kind: "component",
        label: "Worker",
        description: "",
        source: [],
      },
      database: {
        id: "database",
        parentId: null,
        kind: "store",
        label: "Records",
        description: "",
        source: [],
      },
    },
    relationships: {
      writes: {
        id: "writes",
        kind: "semantic",
        fromId: "worker",
        toId: "database",
        label: "Writes",
        explanation: "Stores a result",
      },
    },
  };
  const expanded = hostMapSnapshot(map, "worker");
  const first = await runInlineC4Layout(
    expanded.nodes!,
    expanded.relationships!,
  );
  const worker = first.layout.nodes.find(
    (entry) => entry.node.id === "worker",
  )!;
  const service = first.layout.nodes.find(
    (entry) => entry.node.id === "service",
  )!;
  expect(worker.x).toBeGreaterThanOrEqual(service.x);
  expect(worker.y).toBeGreaterThanOrEqual(service.y);
  expect(worker.x + worker.width).toBeLessThanOrEqual(
    service.x + service.width,
  );
  expect(first.layout.edgeSections.get("writes")?.length).toBeGreaterThan(0);

  const collapsed = hostMapSnapshot(map, "worker", new Set(["service"]));
  const second = await runInlineC4Layout(
    collapsed.nodes!,
    collapsed.relationships!,
    undefined,
    first.inlineLayout,
  );
  expect(second.layout.nodes).toHaveLength(2);
  expect(second.layout.edgeSections.get("writes")?.length).toBeGreaterThan(0);
});
