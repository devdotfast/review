import { createHash } from "node:crypto";

import {
  MAX_SHARE_BYTES,
  MAX_SHARE_MANIFEST_BYTES,
  MAX_SHARE_OBJECT_BYTES,
  SHARE_FORMAT,
  type ShareManifest,
  shareManifestSchema,
} from "@dev.fast/review-share-protocol";
import { z } from "zod";

import { markdownNodes, parseMarkdown } from "../markdown.js";
import { ReviewInputError } from "../review-api/document.js";
import {
  checkReferences,
  documentSchema,
  elements,
  resourceReferences,
  sourceReferences,
} from "../review-api/document.js";
import type { LocalReviewData } from "../review-api/local-data.js";
import type { ReviewStore } from "../review-api/store.js";

export interface ShareBundle {
  manifest: ShareManifest;
  objects: Map<string, Uint8Array>;
  attribution?: { login: string; sharedAt: number };
}

export type ShareExportStore = Pick<ReviewStore, "read" | "resource">;

export type ShareExportData = Pick<
  LocalReviewData,
  "map" | "validateResource" | "validateSource"
>;

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Freeze one stored version before any asynchronous source reads. */
export async function exportShare(input: {
  store: ShareExportStore;
  data: ShareExportData;
  reviewId: string;
  version?: number;
  repository: ShareManifest["repository"];
}): Promise<ShareBundle> {
  const snapshot = structuredClone(
    input.store.read(input.reviewId, input.version),
  );

  documentSchema.parse(snapshot.document);
  checkReferences(snapshot.document);
  const objects = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const add = (bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_SHARE_OBJECT_BYTES)
      throw new ReviewInputError("A shared object exceeds the upload limit.");
    const id = digestBytes(bytes);

    if (!objects.has(id)) {
      totalBytes += bytes.byteLength;

      if (totalBytes > MAX_SHARE_BYTES)
        throw new ReviewInputError("Review exceeds the sharing limit.");
      objects.set(id, Uint8Array.from(bytes));
    }

    return id;
  };

  const json = <Value>(value: Value) => add(Buffer.from(JSON.stringify(value)));
  const resources: ShareManifest["resources"] = [];
  const maps: Record<string, Awaited<ReturnType<LocalReviewData["map"]>>> = {};
  const sources = sourceReferences(snapshot.document);
  const pins = snapshot.pins;

  for (const block of elements(snapshot.document)) {
    if (block.type !== "markdown") continue;

    for (const node of markdownNodes(parseMarkdown(block.markdown)))
      if (node.type === "image")
        throw new ReviewInputError(
          "Convert Markdown images to managed image blocks before sharing.",
        );
  }

  for (const block of resourceReferences(snapshot.document)) {
    await input.data.validateResource(pins, block);

    const id =
      block.type === "image"
        ? block.assetId
        : block.type === "trace_quote"
          ? block.traceId
          : block.type === "software_map"
            ? block.mapVersionId
            : undefined;

    if (!id || resources.some((resource) => resource.id === id)) continue;
    const resource = input.store.resource(id);
    resources.push({
      id,
      kind: z.enum(["image", "trace", "map"]).parse(resource.kind),
      mimeType: z
        .enum(["image/png", "application/json"])
        .parse(resource.mimeType),
      object: add(resource.data),
    });

    if (block.type === "software_map") {
      const map = await input.data.map(pins, id);
      Object.defineProperty(maps, id, { value: map, enumerable: true });

      for (const element of map.elements)
        for (const range of element.sourceRanges ?? [])
          sources.push({
            id: `${id}:${element.id}`,
            source: { ...range, side: map.side },
          });
    }
  }

  for (const reference of sources)
    await input.data.validateSource(pins, reference.source, {
      peek: reference.peek ?? false,
    });

  const snapshotId = json(snapshot);
  const presentationId = json({ maps });

  const manifest = shareManifestSchema.parse({
    format: SHARE_FORMAT,
    reviewId: snapshot.reviewId,
    version: snapshot.version,
    title: snapshot.title,
    snapshot: snapshotId,
    presentation: presentationId,
    objects: [...objects].map(([id, bytes]) => ({
      id,
      sha256: id,
      size: bytes.byteLength,
    })),
    resources,
    repository: input.repository,
  });

  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_SHARE_MANIFEST_BYTES)
    throw new ReviewInputError("The share manifest exceeds the upload limit.");

  return { manifest, objects };
}
