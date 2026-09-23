import { createHash } from "node:crypto";

import {
  MAX_SHARE_BYTES,
  MAX_SHARE_MANIFEST_BYTES,
  MAX_SHARE_OBJECT_BYTES,
  SHARE_FORMAT,
  type ShareManifest,
  shareManifestSchema,
} from "@dev.fast/whiteboard-share-protocol";
import { z } from "zod";

import { sourceAnchors } from "../lens-selection.js";
import { markdownNodes, parseMarkdown } from "../markdown.js";
import { lensSelections } from "../session-api/diff-lenses.js";
import { SessionInputError } from "../session-api/document.js";
import {
  anchorPins,
  checkReferences,
  documentSchema,
  elements,
  resourceReference,
  resourceReferences,
  sourceReferences,
} from "../session-api/document.js";
import type { LocalSessionData } from "../session-api/local-data.js";
import type { SessionStore } from "../session-api/store.js";

export interface ShareBundle {
  manifest: ShareManifest;
  objects: Map<string, Uint8Array>;
  attribution?: { login: string; sharedAt: number };
}

export type ShareExportStore = Pick<SessionStore, "read" | "resource">;

export type ShareExportData = Pick<
  LocalSessionData,
  "map" | "validateResource" | "validateSource"
>;

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Freeze one stored version before any asynchronous source reads. */
export async function exportShare(input: {
  store: ShareExportStore;
  data: ShareExportData;
  sessionId: string;
  version?: number;
  repository: ShareManifest["repository"];
}): Promise<ShareBundle> {
  // A share is the finished document: what edit last touched it stays home.
  const {
    target,
    staleSources: _staleSources,
    sourceUnavailable: _sourceUnavailable,
    lastEdit: _lastEdit,
    ...snapshot
  } = structuredClone(input.store.read(input.sessionId, input.version));

  if (target?.kind === "worktree")
    throw new SessionInputError(
      "Pin this session to commits before sharing it.",
    );

  documentSchema.parse(snapshot.document);
  checkReferences(snapshot.document);
  const objects = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const add = (bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_SHARE_OBJECT_BYTES)
      throw new SessionInputError("A shared object exceeds the upload limit.");
    const id = digestBytes(bytes);

    if (!objects.has(id)) {
      totalBytes += bytes.byteLength;

      if (totalBytes > MAX_SHARE_BYTES)
        throw new SessionInputError("Session exceeds the sharing limit.");
      objects.set(id, Uint8Array.from(bytes));
    }

    return id;
  };

  const json = <Value>(value: Value) => add(Buffer.from(JSON.stringify(value)));
  const resources: ShareManifest["resources"] = [];
  const maps: Record<string, Awaited<ReturnType<LocalSessionData["map"]>>> = {};

  // Lens ranges travel with the snapshot and must resolve at its pins too.
  const sources = [
    ...sourceReferences(snapshot.document),
    ...lensSelections(snapshot.lenses ?? []).flatMap((selection) =>
      sourceAnchors(selection.source).map((source) => ({
        ...selection,
        source,
        peek: false,
      })),
    ),
  ];

  const pins = snapshot.pins;

  if (!pins)
    throw new SessionInputError(
      "A document without source pins of its own cannot be shared.",
      409,
    );

  for (const block of elements(snapshot.document)) {
    if (block.type !== "markdown") continue;

    for (const node of markdownNodes(parseMarkdown(block.markdown)))
      if (node.type === "image")
        throw new SessionInputError(
          "Convert Markdown images to managed image blocks before sharing.",
        );
  }

  for (const block of resourceReferences(snapshot.document)) {
    await input.data.validateResource(pins, block);

    const reference = resourceReference(block);

    if (
      !reference ||
      resources.some((resource) => resource.id === reference.id)
    )
      continue;
    const { id } = reference;
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
    await input.data.validateSource(
      anchorPins(reference.source, pins),
      reference.source,
      { peek: reference.peek ?? false },
    );

  const snapshotId = json(snapshot);
  const presentationId = json({ maps });

  const manifest = shareManifestSchema.parse({
    format: SHARE_FORMAT,
    sessionId: snapshot.sessionId,
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
    throw new SessionInputError("The share manifest exceeds the upload limit.");

  return { manifest, objects };
}
