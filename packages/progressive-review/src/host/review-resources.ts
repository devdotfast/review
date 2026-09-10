import { createHash, randomUUID } from "node:crypto";

import {
  HOST_LIMITS,
  HOST_RESOURCE_COMMANDS,
  HOST_RESOURCE_LIMITS,
  HOST_RESOURCE_QUERIES,
  HostAssetSchema,
  type HostBinding,
  type HostCheckpoint,
  type HostDiagnostic,
  HostDocumentValidationError,
  type HostMap,
  type HostMapOperation,
  HostMapSchema,
  type HostResourceCommand,
  type HostResourceQuery,
  HostRetainedTraceSchema,
  type HostSourceQuote,
  HostSourceQuoteSchema,
  type HostSourceSpan,
  type JsonValue,
  canonicalHostJson,
} from "@dev.fast/review-protocol";
import sharp from "sharp";

import type { HostDocumentEvidenceResources } from "./document-evidence";
import {
  type EvidenceProvider,
  EvidenceProviderError,
} from "./evidence-provider";
import {
  type HostPreparedMap,
  HostStoreError,
  ReviewHostStore,
} from "./review-host-store";

/** Retained resources share the host's transaction, authorization and receipt boundary. */
export class ReviewResources {
  constructor(
    private readonly store: ReviewHostStore,
    private readonly evidence: EvidenceProvider,
  ) {}

  async prepare(request: HostResourceCommand): Promise<() => JsonValue> {
    const reviewId = request.input.reviewId;
    this.mutableReview(reviewId);
    switch (request.type) {
      case "map.create": {
        const { input } = request;
        const document = this.store.document(reviewId, input.documentVersion);
        const commit =
          input.side === "base"
            ? document.binding.baseCommit
            : document.binding.headCommit;
        const prepared = await this.prepareMap(
          input.map,
          document.binding.repositoryId,
          commit,
          {},
        );
        return () => {
          const version = this.store.createMap(reviewId, prepared);
          this.store.appendEvent(reviewId, "map.committed", {
            mapId: version.mapId,
            mapVersionId: version.id,
          });
          return version;
        };
      }
      case "map.mutate": {
        const { input } = request;
        const before = this.store.currentMap(reviewId, input.mapId);
        if (before.revision !== input.expectedVersion)
          throw new HostStoreError(
            "VERSION_CONFLICT",
            "Map changed. Read its current revision and retry.",
          );
        const map = applyMapOperations(before, input.operations);
        const prepared = await this.prepareMap(
          map,
          before.repositoryId,
          before.commit,
          this.store.mapEvidence(reviewId, before.id),
        );
        return () => {
          const after = this.store.commitMap(
            reviewId,
            before.mapId,
            input.expectedVersion,
            prepared,
          );
          if (after.id !== before.id)
            this.store.appendEvent(reviewId, "map.committed", {
              mapId: after.mapId,
              mapVersionId: after.id,
            });
          return after;
        };
      }
      case "trace.ingest": {
        const { input } = request;
        if (input.parentTraceId)
          this.store.trace(reviewId, input.parentTraceId);
        const ids = new Set<string>();
        const ordinals = new Set<number>();
        for (const event of input.events) {
          if (ids.has(event.id) || ordinals.has(event.ordinal))
            invalid("Trace event IDs and ordinals must be unique.", "/events");
          ids.add(event.id);
          ordinals.add(event.ordinal);
          boundedText(
            event.text,
            HOST_RESOURCE_LIMITS.traceEventBytes,
            "Trace event",
          );
        }
        bounded(
          input,
          HOST_RESOURCE_LIMITS.traceBytes,
          "Selected trace material",
        );
        const traceId = randomUUID();
        const retained = HostRetainedTraceSchema.parse({
          trace: {
            id: traceId,
            sessionId: null,
            parentTraceId: input.parentTraceId ?? null,
            label: input.label,
            version: 0,
            createdAt: new Date().toISOString(),
            provenance: "client_supplied",
          },
          events: [...input.events]
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((event) => {
              const value = { ...event, traceId };
              return { ...value, contentHash: hash(value) };
            }),
        });
        return () => {
          this.store.putTrace(reviewId, retained);
          this.store.appendEvent(reviewId, "trace.ingested", {
            traceId,
            version: 0,
          });
          return retained.trace;
        };
      }
      case "asset.upload": {
        const assetInput = HOST_RESOURCE_COMMANDS["asset.upload"].input.parse(
          request.input,
        );
        const bytes = Buffer.from(assetInput.base64, "base64");
        if (bytes.toString("base64") !== assetInput.base64)
          invalid("Image content must use canonical base64.", "/base64");
        if (bytes.length > HOST_LIMITS.assetBytes)
          limit("Image exceeds the maximum retained byte size.");
        const format = imageFormat(bytes);
        if (
          !format ||
          `image/${format === "jpeg" ? "jpeg" : format}` !== assetInput.mimeType
        )
          invalid(
            "Image bytes must match the declared PNG, JPEG or WebP format.",
            "/mimeType",
          );
        let width: number;
        let height: number;
        try {
          // Metadata does not decode pixels. Check the declared dimensions before
          // a bounded full decode; accepting a header alone would admit corrupt data.
          const metadata = await sharp(bytes, {
            failOn: "warning",
            limitInputPixels: false,
          }).metadata();
          if (
            metadata.format !== format ||
            !metadata.width ||
            !metadata.height ||
            (metadata.pages ?? 1) !== 1
          )
            invalid(
              "Only a single complete raster image may be retained.",
              "/base64",
            );
          width = metadata.width;
          height = metadata.height;
          if (width * height > HOST_LIMITS.assetPixels)
            limit("Image exceeds the maximum pixel count.");
          await sharp(bytes, {
            failOn: "warning",
            limitInputPixels: HOST_LIMITS.assetPixels,
          })
            .raw()
            .toBuffer();
        } catch (error) {
          if (
            error instanceof HostDocumentValidationError ||
            error instanceof EvidenceProviderError
          )
            throw error;
          invalid("Image content could not be decoded safely.", "/base64");
        }
        const asset = HostAssetSchema.parse({
          id: randomUUID(),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mimeType: assetInput.mimeType,
          byteLength: bytes.length,
          width,
          height,
          createdAt: new Date().toISOString(),
        });
        return () => {
          this.store.putAsset(reviewId, asset, bytes);
          this.store.appendEvent(reviewId, "asset.uploaded", {
            assetId: asset.id,
          });
          return asset;
        };
      }
    }
  }

  query(request: HostResourceQuery): JsonValue {
    const { reviewId } = request.input;
    switch (request.type) {
      case "map.get":
        return this.store.mapVersion(reviewId, request.input.mapVersionId);
      case "maps.list":
        return this.store.maps(reviewId, request.input);
      case "trace.get":
        return this.store.trace(reviewId, request.input.traceId);
      case "asset.get": {
        const { asset, bytes } = this.store.asset(
          reviewId,
          request.input.assetId,
        );
        return HOST_RESOURCE_QUERIES["asset.get"].result.parse({
          asset,
          base64: Buffer.from(bytes).toString("base64"),
        });
      }
    }
  }

  lookups(reviewId: string): HostDocumentEvidenceResources {
    return {
      mapVersion: (id) =>
        optionalResource(() => this.store.mapVersion(reviewId, id)),
      traceEvent: (traceId, eventId) =>
        optionalResource(() =>
          this.store
            .trace(reviewId, traceId)
            .events.find((event) => event.id === eventId),
        ),
      asset: (id) =>
        optionalResource(() => this.store.asset(reviewId, id).asset),
    };
  }

  validatePublication(
    reviewId: string,
    binding: HostBinding,
    mapVersions: HostCheckpoint["mapVersions"],
  ): void {
    for (const side of ["base", "head"] as const) {
      const id = mapVersions[side];
      if (id === null) continue;
      const map = this.store.mapVersion(reviewId, id);
      const commit = side === "base" ? binding.baseCommit : binding.headCommit;
      if (map.repositoryId !== binding.repositoryId || map.commit !== commit)
        invalid(
          "Published maps must match the selected review side's exact repository and commit.",
          `/mapVersions/${side}`,
        );
    }
  }

  private mutableReview(reviewId: string) {
    const review = this.store.review(reviewId);
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
  }

  private async prepareMap(
    map: HostMap,
    repositoryId: string,
    commit: string,
    previous: Record<string, HostSourceQuote>,
  ): Promise<HostPreparedMap> {
    const parsed = HostMapSchema.parse(map);
    bounded(parsed, HOST_RESOURCE_LIMITS.mapBytes, "Map");
    validateMap(parsed);
    const spans = new Map<string, HostSourceSpan>();
    for (const element of Object.values(parsed.elements))
      for (const span of element.source) spans.set(hash(span), span);
    for (const relationship of Object.values(parsed.relationships))
      if (relationship.kind === "call")
        spans.set(hash(relationship.evidence), relationship.evidence);
    const binding: HostBinding = {
      id: randomUUID(),
      repositoryId,
      selector: { kind: "snapshot", ref: commit },
      baseCommit: commit,
      headCommit: commit,
      createdAt: new Date().toISOString(),
    };
    const evidence: Record<string, HostSourceQuote> = {};
    for (const [key, span] of spans) {
      if (span.repositoryId !== repositoryId || span.commit !== commit)
        invalid(
          "Map source must belong to its exact pinned repository and commit.",
          "/elements",
        );
      const retained = previous[key];
      if (retained) evidence[key] = retained;
      else {
        const quote = HostSourceQuoteSchema.parse(
          await this.evidence.resolve(binding, {
            side: "head",
            file: span.file,
            fromLine: span.fromLine,
            toLine: span.toLine,
          }),
        );
        if (
          canonicalHostJson(quote.span) !== canonicalHostJson(span) ||
          createHash("sha256").update(quote.text).digest("hex") !== quote.sha256
        )
          invalid(
            "Map source does not match the verified repository blob and range.",
            "/elements",
          );
        evidence[key] = quote;
      }
    }
    bounded(
      evidence,
      HOST_RESOURCE_LIMITS.mapEvidenceBytes,
      "Retained map evidence",
    );
    return { repositoryId, commit, map: parsed, evidence };
  }
}

function applyMapOperations(
  before: HostMap,
  operations: HostMapOperation[],
): HostMap {
  const map: HostMap = {
    schemaVersion: 1,
    elements: structuredClone(before.elements),
    relationships: structuredClone(before.relationships),
  };
  for (const operation of operations) {
    switch (operation.op) {
      case "element.put":
        map.elements[operation.element.id] = structuredClone(operation.element);
        break;
      case "relationship.put":
        map.relationships[operation.relationship.id] = structuredClone(
          operation.relationship,
        );
        break;
      case "element.remove":
        if (!Object.hasOwn(map.elements, operation.id))
          invalid(
            "Cannot remove a missing map element.",
            `/elements/${operation.id}`,
          );
        delete map.elements[operation.id];
        break;
      case "relationship.remove":
        if (!Object.hasOwn(map.relationships, operation.id))
          invalid(
            "Cannot remove a missing map relationship.",
            `/relationships/${operation.id}`,
          );
        delete map.relationships[operation.id];
        break;
    }
  }
  return map;
}

function validateMap(map: HostMap): void {
  const diagnostics: HostDiagnostic[] = [];
  const issue = (path: string, message: string) => {
    if (diagnostics.length < 100)
      diagnostics.push({
        severity: "error",
        code: "INVALID_MAP",
        message,
        path,
      });
  };
  for (const [id, element] of Object.entries(map.elements)) {
    if (element.id !== id)
      issue(`/elements/${id}/id`, "Element key and stable ID must agree.");
    if (
      element.parentId !== null &&
      !Object.hasOwn(map.elements, element.parentId)
    )
      issue(`/elements/${id}/parentId`, "Element parent does not exist.");
    if (element.store && element.kind !== "store")
      issue(
        `/elements/${id}/store`,
        "Only store elements may define collections.",
      );
    const ancestors = new Set([id]);
    let parent = element.parentId;
    while (parent !== null && Object.hasOwn(map.elements, parent)) {
      if (ancestors.has(parent)) {
        issue(
          `/elements/${id}/parentId`,
          "Map hierarchy cannot contain a cycle.",
        );
        break;
      }
      ancestors.add(parent);
      if (ancestors.size > HOST_LIMITS.depth) {
        issue(
          `/elements/${id}/parentId`,
          "Map hierarchy exceeds the maximum depth.",
        );
        break;
      }
      parent = map.elements[parent]!.parentId;
    }
  }
  for (const [id, relationship] of Object.entries(map.relationships)) {
    if (relationship.id !== id)
      issue(
        `/relationships/${id}/id`,
        "Relationship key and stable ID must agree.",
      );
    if (
      !Object.hasOwn(map.elements, relationship.fromId) ||
      !Object.hasOwn(map.elements, relationship.toId)
    )
      issue(
        `/relationships/${id}`,
        "Relationship endpoints must name map elements.",
      );
  }
  if (diagnostics.length) throw new HostDocumentValidationError(diagnostics);
}

function imageFormat(bytes: Uint8Array): "png" | "jpeg" | "webp" | undefined {
  const buffer = Buffer.from(bytes);
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return "jpeg";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return undefined;
}
function optionalResource<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof HostStoreError && error.code === "NOT_FOUND")
      return undefined;
    throw error;
  }
}
function hash(value: JsonValue): string {
  return createHash("sha256").update(canonicalHostJson(value)).digest("hex");
}
function bounded(value: JsonValue, maximum: number, label: string): void {
  boundedText(canonicalHostJson(value), maximum, label);
}
function boundedText(text: string, maximum: number, label: string): void {
  if (Buffer.byteLength(text) > maximum)
    limit(`${label} exceeds its byte limit.`);
}
function limit(message: string): never {
  throw new EvidenceProviderError("RESOURCE_LIMIT", message);
}
function invalid(message: string, path: string): never {
  throw new HostDocumentValidationError([
    { severity: "error", code: "INVALID_RESOURCE", message, path },
  ]);
}
