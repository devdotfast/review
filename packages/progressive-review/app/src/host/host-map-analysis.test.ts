import {
  HostDocumentStateSchema,
  type HostMapElementAnalysis,
  HostQueryBodySchema,
  HostReviewVersionHeaderSchema,
  ReviewClient,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import { hostMapModel } from "../host-document-components";
import { projectInlineC4 } from "../software-map/c4-projection";
import { defineSoftwareModel } from "../software-map/model";
import { softwareMapResolvedDataInputForModel } from "../software-map/software-map-resolved-data";
import {
  buildSoftwareMapChangeSummaries,
  parseSoftwareMapResolvedDataResponse,
} from "../software-map/software-map-snapshot";
import { resolveHostSoftwareMapData } from "./host-map-analysis";

const id = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const baseId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const headId = "8afbc67c-089e-4d84-95d1-16d5e4710485";
const at = "2026-09-10T12:00:00Z";
const binding = {
  id,
  repositoryId: id,
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  createdAt: at,
  selector: { kind: "range", baseRef: "main", headRef: "feature" },
};
const document = HostDocumentStateSchema.parse({
  schemaVersion: 1,
  roots: [],
  nodes: {},
  definitions: {},
  evidence: {},
  reviewId: id,
  reviewVersion: 7,
  binding,
  contentHash: "c".repeat(64),
  createdAt: at,
});
const snapshot = HostReviewVersionHeaderSchema.parse({
  reviewId: id,
  reviewVersion: 7,
  binding,
  title: "Saved review",
  description: "",
  labels: [],
  mapVersions: { base: baseId, head: headId },
  createdBy: id,
  createdAt: at,
  restoredFromReviewVersion: null,
});

describe("existing map UI saved-resource adapter", () => {
  it("carries only the immutable map locator instead of duplicating source and graph inputs", () => {
    const model = hostMapModel({
      schemaVersion: 1,
      id: headId,
      mapId: headId,
      repositoryId: id,
      commit: binding.headCommit,
      mapVersion: 0,
      contentHash: "d".repeat(64),
      createdAt: at,
      elements: {
        app: {
          id: "app",
          parentId: null,
          kind: "component",
          label: "App",
          description: "",
          source: [],
        },
      },
      relationships: {},
    });
    expect(softwareMapResolvedDataInputForModel(model)).toEqual({
      savedMap: { id: headId, commit: binding.headCommit },
      codeElements: [],
      coverageClaims: [],
    });
  });

  it("reads the complete saved pair through paged analysis and converts exact side coordinates for the old view", async () => {
    const first: HostMapElementAnalysis = {
      elementId: "app",
      presence: { base: true, head: true },
      changeStatus: "modified",
      additions: 1,
      deletions: 1,
      diff: {
        files: [
          {
            baseFile: "old.ts",
            headFile: "new.ts",
            hunks: [
              {
                baseRange: { startLine: 3, lineCount: 1 },
                headRange: { startLine: 4, lineCount: 1 },
                attribution: "overlap",
                lines: [
                  { kind: "remove", baseLine: 3, headLine: null, text: "old" },
                  { kind: "add", baseLine: null, headLine: 4, text: "new" },
                ],
              },
            ],
          },
        ],
      },
    };
    const second: HostMapElementAnalysis = {
      elementId: "database",
      presence: { base: false, head: true },
      changeStatus: "added",
      additions: 0,
      deletions: 0,
      diff: { files: [] },
    };
    const queries: ReturnType<typeof HostQueryBodySchema.parse>[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/connection"))
        return Response.json({
          ok: true,
          data: {
            apiVersion: 1,
            hostId: id,
            workspaceId: id,
            principal: { id, kind: "human", displayName: "You" },
          },
        });
      const query = HostQueryBodySchema.parse(JSON.parse(String(init?.body)));
      queries.push(query);
      if (query.type !== "map.analyze") throw new Error("Unexpected query");
      return Response.json({
        ok: true,
        data: {
          eventCursor: "cursor",
          result: {
            reviewVersion: 7,
            mapVersions: query.input.mapVersions,
            comparison: {
              baseCommit: binding.baseCommit,
              headCommit: binding.headCommit,
            },
            items: query.input.cursor ? [second] : [first],
            nextCursor: query.input.cursor ? null : "next-page",
          },
        },
      });
    });
    const client = await ReviewClient.connect({
      serverUrl: "http://localhost:4000",
      token: "credential",
      fetch: request,
    });
    const result = await resolveHostSoftwareMapData(
      client,
      { document, snapshot },
      { savedMap: { id: headId, commit: binding.headCommit } },
    );
    expect(queries).toEqual([
      {
        type: "map.analyze",
        input: {
          reviewId: id,
          reviewVersion: 7,
          mapVersions: { base: baseId, head: headId },
          includeDiff: true,
          limit: 200,
        },
      },
      {
        type: "map.analyze",
        input: {
          reviewId: id,
          reviewVersion: 7,
          mapVersions: { base: baseId, head: headId },
          includeDiff: true,
          limit: 200,
          cursor: "next-page",
        },
      },
    ]);
    expect(result.countsByElementPath).toMatchObject({
      app: { additions: 1, deletions: 1 },
      database: { additions: 0, deletions: 0 },
    });
    const resolved = parseSoftwareMapResolvedDataResponse(
      parseJsonText(JSON.stringify(result)),
    );
    const model = defineSoftwareModel({
      systems: { app: { label: "App" }, database: { label: "Database" } },
    });
    const summaries = buildSoftwareMapChangeSummaries(
      model,
      resolved.counts,
      resolved.unmappedByElementPath,
    );
    expect(summaries.get("database")?.changeStatus).toBe("added");
    const projection = projectInlineC4({
      model,
      expandedNodeIds: new Set(),
      modifiedOnly: true,
      changedNodeIds: new Set(
        [...summaries]
          .filter(([, summary]) => summary.changeStatus !== "unchanged")
          .map(([id]) => id),
      ),
    });
    expect(projection.nodes.map((node) => node.id).sort()).toEqual([
      "app",
      "database",
    ]);
    expect(result.unmappedByElementPath.app!.files[0]).toEqual({
      file: "new.ts",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          startLine: 4,
          lines: [
            { kind: "remove", oldLine: 3, newLine: null, text: "old" },
            { kind: "add", oldLine: null, newLine: 4, text: "new" },
          ],
        },
      ],
    });
  });

  it("uses an inline unselected map by its pinned side and rejects maps outside the snapshot comparison", async () => {
    const queries: ReturnType<typeof HostQueryBodySchema.parse>[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/connection"))
        return Response.json({
          ok: true,
          data: {
            apiVersion: 1,
            hostId: id,
            workspaceId: id,
            principal: { id, kind: "human", displayName: "You" },
          },
        });
      const query = HostQueryBodySchema.parse(JSON.parse(String(init?.body)));
      queries.push(query);
      if (query.type !== "map.analyze") throw new Error("Unexpected query");
      return Response.json({
        ok: true,
        data: {
          eventCursor: "cursor",
          result: {
            reviewVersion: 7,
            mapVersions: query.input.mapVersions,
            comparison: {
              baseCommit: binding.baseCommit,
              headCommit: binding.headCommit,
            },
            items: [],
            nextCursor: null,
          },
        },
      });
    });
    const client = await ReviewClient.connect({
      serverUrl: "http://localhost:4000",
      token: "credential",
      fetch: request,
    });
    await resolveHostSoftwareMapData(
      client,
      { document, snapshot },
      { savedMap: { id, commit: binding.baseCommit } },
    );
    expect(queries[0]).toMatchObject({
      type: "map.analyze",
      input: { mapVersions: { base: id, head: null } },
    });
    await expect(
      resolveHostSoftwareMapData(
        client,
        { document, snapshot },
        { savedMap: { id, commit: "f".repeat(40) } },
      ),
    ).rejects.toThrow(/does not match/);
    expect(queries).toHaveLength(1);
  });
});
