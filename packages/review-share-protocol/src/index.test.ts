import { expect, it } from "vitest";

import {
  parseShareLink,
  shareLink,
  shareManifestSchema,
  sharePathSchema,
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";

it("keeps the capability in a fragment and rejects credentials or unexpected link paths", () => {
  const token = "a".repeat(43),
    url = shareLink("https://app.dev.fast", id, token);

  expect(parseShareLink(url)).toEqual({
    origin: "https://app.dev.fast",
    shareId: id,
    capability: token,
  });
  expect(new URL(url).search).toBe("");
  expect(() =>
    parseShareLink(url.replace("https://", "https://user:password@")),
  ).toThrow("HTTPS");
  expect(() => parseShareLink(url.replace("/s/", "/other/"))).toThrow(
    /UUID|string/i,
  );
});

it("rejects traversal paths and platform-specific separators", () => {
  for (const file of [
    "../secret",
    "a/../../secret",
    "/etc/passwd",
    "a\\b",
    "a//b",
    "./a",
    "a\0b",
  ])
    expect(sharePathSchema.safeParse(file).success).toBe(false);
  expect(sharePathSchema.parse("src/[route]/index.ts")).toBe(
    "src/[route]/index.ts",
  );
});

it("rejects references not declared by the immutable envelope", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64);

  const manifest = {
    format: "review-share/1",
    reviewId: "review",
    version: 1,
    title: "Title",
    snapshot: a,
    presentation: b,
    objects: [
      { id: a, sha256: a, size: 1 },
      { id: b, sha256: b, size: 1 },
    ],
    resources: [],
    files: [],
  };

  expect(shareManifestSchema.safeParse(manifest).success).toBe(true);
  expect(
    shareManifestSchema.safeParse({
      ...manifest,
      files: [{ side: "head", file: "a.ts", object: "c".repeat(64) }],
    }).success,
  ).toBe(false);
  expect(
    shareManifestSchema.safeParse({
      ...manifest,
      objects: [manifest.objects[0], manifest.objects[0]],
    }).success,
  ).toBe(false);
});
