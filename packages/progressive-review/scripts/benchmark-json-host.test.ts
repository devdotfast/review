import { createHash } from "node:crypto";

import {
  type HostBinding,
  type HostDocument,
  type HostMapVersion,
  applyHostDocumentOperations,
} from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import { validateHostDocumentEvidence } from "../src/host/document-evidence";
import type { EvidenceProvider } from "../src/host/evidence-provider";
import { fixtureDocument, fixtureSteps } from "./benchmark-json-host";

const repositoryId = "00000000-0000-4000-8000-000000000001";
const refs: Parameters<typeof fixtureDocument>[0] = {
  baseRange: { side: "base", file: "src/host.ts", fromLine: 1, toLine: 2 },
  headRange: { side: "head", file: "src/host.ts", fromLine: 1, toLine: 2 },
  mapVersionId: "00000000-0000-4000-8000-000000000002",
  traceId: "00000000-0000-4000-8000-000000000003",
  eventId: "00000000-0000-4000-8000-000000000004",
  assetId: "00000000-0000-4000-8000-000000000005",
};
const binding: HostBinding = {
  id: "00000000-0000-4000-8000-000000000006",
  repositoryId,
  selector: { kind: "snapshot", ref: "a".repeat(40) },
  baseCommit: "a".repeat(40),
  headCommit: "a".repeat(40),
  createdAt: "2026-09-10T00:00:00Z",
};
const provider: EvidenceProvider = {
  async resolve(pins, range) {
    const text = "export function command() {\n  return accepted;";
    return {
      span: {
        repositoryId,
        commit: range.side === "base" ? pins.baseCommit : pins.headCommit,
        blob: "b".repeat(40),
        file: range.file,
        fromLine: range.fromLine,
        toLine: range.toLine,
      },
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  },
};
const map: HostMapVersion = {
  schemaVersion: 1,
  id: refs.mapVersionId,
  mapId: "00000000-0000-4000-8000-000000000007",
  repositoryId,
  commit: binding.headCommit,
  revision: 0,
  contentHash: "c".repeat(64),
  createdAt: binding.createdAt,
  elements: {
    host: {
      id: "host",
      label: "Host",
      description: "Host",
      parentId: null,
      kind: "component",
      source: [],
    },
  },
  relationships: {},
};

describe("real-desktop validation fixture preparation", () => {
  it.each([16, 20, 200, 1000])(
    "prepares a valid %i-node mixed document without claiming a frontend measurement",
    async (count) => {
      const document = fixtureDocument(refs, count);
      const accepted = await validateHostDocumentEvidence({
        document,
        binding,
        provider,
        resources: {
          mapVersion: () => map,
          asset: () => ({ id: refs.assetId }),
          traceEvent: () => ({
            id: refs.eventId,
            traceId: refs.traceId,
            text: "Review API accepted an atomic document update.",
          }),
        },
      });
      expect(Object.keys(document.nodes)).toHaveLength(count);
      expect(accepted.evidence.base_source?.span.commit).toBe(
        binding.baseCommit,
      );
      expect(accepted.evidence.head_source?.span.commit).toBe(
        binding.headCommit,
      );
      expect(accepted.affectedNodeIds).toHaveLength(count);
    },
  );

  it("reaches the same gallery through individually valid atomic steps with container children in place", () => {
    const desired = fixtureDocument(refs);
    let document: HostDocument = {
      schemaVersion: 1,
      roots: [],
      nodes: {},
      definitions: {},
    };
    for (const step of fixtureSteps(desired))
      document = applyHostDocumentOperations(document, step.operations);
    expect(document).toEqual(desired);
    expect(document.nodes.section).toMatchObject({
      children: ["section_text"],
    });
    expect(document.nodes.callout).toMatchObject({
      children: ["callout_text"],
    });
  });
});
