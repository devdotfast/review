import {
  HOST_LIMITS,
  type HostMapVersion,
  type HostQuery,
  HostQuerySchema,
  type HostRetainedTrace,
  ReviewClient,
} from "@dev.fast/review-protocol";
import { expect, it, vi } from "vitest";

import { decodeHostImage, loadHostResource } from "./host-canvas-resources";

const id = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const otherId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const at = "2026-09-10T12:00:00Z";
const hash = "a".repeat(64);
const oid = "b".repeat(40);

async function imageResult() {
  const bytes = Uint8Array.of(137, 80, 78, 71);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    asset: {
      id,
      sha256,
      mimeType: "image/png" as const,
      byteLength: bytes.length,
      width: 1,
      height: 1,
      createdAt: at,
    },
    base64: btoa(String.fromCharCode(...bytes)),
  };
}

it("decodes only bounded image bytes whose length and checksum match the host metadata", async () => {
  const result = await imageResult();
  const image = await decodeHostImage(result);
  expect(image.bytes).toEqual(Uint8Array.of(137, 80, 78, 71));
  expect(image.mimeType).toBe("image/png");
  await expect(
    decodeHostImage({ ...result, asset: { ...result.asset, sha256: hash } }),
  ).rejects.toThrow("integrity check");
  await expect(
    decodeHostImage({ ...result, asset: { ...result.asset, byteLength: 5 } }),
  ).rejects.toThrow("length does not match");
  await expect(
    decodeHostImage({
      ...result,
      asset: { ...result.asset, width: HOST_LIMITS.assetPixels, height: 2 },
    }),
  ).rejects.toThrow("display limits");
});

it("loads exact map, trace and image identities through review-scoped authenticated queries", async () => {
  const image = await imageResult();
  const map: HostMapVersion = {
    schemaVersion: 1,
    id,
    mapId: id,
    repositoryId: id,
    commit: oid,
    contentHash: hash,
    createdAt: at,
    mapVersion: 1,
    elements: {
      worker: {
        id: "worker",
        parentId: null,
        kind: "component",
        label: "Worker",
        description: "",
        source: [],
      },
    },
    relationships: {},
  };
  const trace: HostRetainedTrace = {
    trace: {
      id,
      label: "Authoring note",
      createdAt: at,
      provenance: "client_supplied",
    },
    events: [
      {
        id: otherId,
        traceId: id,
        ordinal: 0,
        at,
        kind: "assistant",
        text: "Look here",
        contentHash: hash,
      },
    ],
  };
  const calls: HostQuery[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("x-review-token")).toBe("credential");
    if (String(input).endsWith("/connection"))
      return Response.json({
        ok: true,
        data: {
          apiVersion: 1,
          hostId: id,
          workspaceId: id,
          principal: { id, kind: "human", displayName: "You" },
        },
      });
    const query = HostQuerySchema.parse({
      ...JSON.parse(String(init?.body)),
      apiVersion: 1,
      hostId: id,
      workspaceId: id,
      clientId: id,
    });
    calls.push(query);
    const result = (() => {
      switch (query.type) {
        case "map.get":
          return map;
        case "trace.get":
          return trace;
        case "asset.get":
          return image;
        default:
          throw new Error("Unexpected query");
      }
    })();
    return Response.json({ ok: true, data: { result, eventCursor: "cursor" } });
  });
  const client = await ReviewClient.connect({
    serverUrl: "http://localhost:4000",
    token: "credential",
    fetch: request,
  });
  const signal = new AbortController().signal;
  const loadedMap = await loadHostResource(
    client,
    otherId,
    { kind: "map", id },
    signal,
  );
  const loadedTrace = await loadHostResource(
    client,
    otherId,
    { kind: "trace", id },
    signal,
  );
  const loadedImage = await loadHostResource(
    client,
    otherId,
    { kind: "asset", id },
    signal,
  );
  expect(loadedMap).toEqual({ kind: "map", value: map });
  expect(loadedTrace).toEqual({
    kind: "trace",
    value: {
      id,
      provenance: "client_supplied",
      label: "Authoring note",
      events: {
        [otherId]: { id: otherId, text: "Look here", role: "assistant" },
      },
    },
  });
  expect(loadedImage.kind).toBe("asset");
  expect(calls.map((call) => call.input)).toEqual([
    { reviewId: otherId, mapVersionId: id },
    { reviewId: otherId, traceId: id },
    { reviewId: otherId, assetId: id },
  ]);
  await expect(
    loadHostResource(client, otherId, { kind: "trace", id: otherId }, signal),
  ).rejects.toThrow("different retained trace");
});
