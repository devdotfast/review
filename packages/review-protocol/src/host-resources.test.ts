import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HOST_LIMITS } from "./host-document.js";
import {
  HOST_RESOURCE_COMMANDS,
  HOST_RESOURCE_LIMITS,
  HostAssetSchema,
} from "./host-resources.js";

const id = "00000000-0000-4000-8000-000000000001";
const event = {
  id,
  ordinal: 42,
  at: "2026-09-10T12:00:00Z",
  kind: "assistant",
  text: "Selected excerpt",
};

describe("retained resource wire schemas", () => {
  it("accepts selected event identities but not trusted provenance, sessions, or claimed content hashes", () => {
    const input = { reviewId: id, label: "Selected material", events: [event] };
    expect(
      HOST_RESOURCE_COMMANDS["trace.ingest"].input.parse(input).events[0]
        ?.ordinal,
    ).toBe(42);
    for (const extra of [
      { provenance: "harness_collected" },
      { sessionId: id },
      { createdBy: id },
    ])
      expect(
        HOST_RESOURCE_COMMANDS["trace.ingest"].input.safeParse({
          ...input,
          ...extra,
        }).success,
      ).toBe(false);
    expect(
      HOST_RESOURCE_COMMANDS["trace.ingest"].input.safeParse({
        ...input,
        events: [{ ...event, contentHash: "a".repeat(64) }],
      }).success,
    ).toBe(false);
  });

  it("requires embedded raster bytes, not URLs, filesystem paths or SVG", () => {
    const input = { reviewId: id, mimeType: "image/png", base64: "AAAA" };
    expect(
      HOST_RESOURCE_COMMANDS["asset.upload"].input.safeParse(input).success,
    ).toBe(true);
    for (const bad of [
      { ...input, mimeType: "image/svg+xml" },
      { ...input, base64: "https://example.com/image.png" },
      { ...input, path: "/private/image.png" },
      { ...input, base64: "data:image/png;base64,AAAA" },
    ])
      expect(
        HOST_RESOURCE_COMMANDS["asset.upload"].input.safeParse(bad).success,
      ).toBe(false);
  });

  it("describes raster and payload bounds in generated schemas without losing the closed-object checks", () => {
    const generated = z.fromJSONSchema(
      z.toJSONSchema(HOST_RESOURCE_COMMANDS["asset.upload"].input, {
        io: "input",
      }),
    );
    expect(
      generated.safeParse({
        reviewId: id,
        mimeType: "image/png",
        base64: "AAAA",
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      generated.safeParse({
        reviewId: id,
        mimeType: "image/svg+xml",
        base64: "AAAA",
      }).success,
    ).toBe(false);
    expect(4 * Math.ceil(HOST_LIMITS.assetBytes / 3)).toBeLessThan(
      HOST_RESOURCE_LIMITS.assetUploadRequestBytes,
    );
    expect(
      HostAssetSchema.safeParse({
        id,
        sha256: "a".repeat(64),
        mimeType: "image/png",
        byteLength: 1,
        width: 0,
        height: 1,
        createdAt: event.at,
      }).success,
    ).toBe(false);
  });
});
