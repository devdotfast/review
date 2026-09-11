import { createHash, randomUUID } from "node:crypto";

import {
  HOST_LIMITS,
  HOST_RESOURCE_COMMANDS,
  HOST_RESOURCE_LIMITS,
  HOST_RESOURCE_QUERIES,
  HostAssetSchema,
  type HostAuthoredMap,
  type HostAuthoredMapOperation,
  HostAuthoredMapSchema,
  type HostBinding,
  type HostDiagnostic,
  HostDocumentValidationError,
  type HostMap,
  type HostMapAnalysisInput,
  HostMapAnalysisInputSchema,
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
import type { LocalRepositorySource } from "./local-repository";
import { analyzeMapChanges } from "./map-analysis";
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
        const input = HOST_RESOURCE_COMMANDS["map.create"].input.parse(
          request.input,
        );
        const document = this.store.reviewSnapshot(
          reviewId,
          input.reviewVersion,
        );
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
          this.mutableReview(reviewId);
          const version = this.store.createMap(reviewId, prepared);
          return version;
        };
      }
      case "map.mutate": {
        const input = HOST_RESOURCE_COMMANDS["map.mutate"].input.parse(
          request.input,
        );
        const before = this.store.currentMap(reviewId, input.mapId);
        if (before.mapVersion !== input.expectedMapVersion)
          throw new HostStoreError(
            "VERSION_CONFLICT",
            "Map changed. Read its current revision and retry.",
            before.mapVersion,
          );
        const map = applyMapOperations(before, input.operations);
        const prepared = await this.prepareMap(
          map,
          before.repositoryId,
          before.commit,
          this.store.mapEvidence(reviewId, before.id),
        );
        return () => {
          this.mutableReview(reviewId);
          const after = this.store.commitMap(
            reviewId,
            before.mapId,
            input.expectedMapVersion,
            prepared,
          );
          return after;
        };
      }
      case "trace.ingest": {
        const input = HOST_RESOURCE_COMMANDS["trace.ingest"].input.parse(
          request.input,
        );
        const ids = new Set<string>();
        for (const event of input.events) {
          if (ids.has(event.id))
            invalid("Trace event IDs must be unique.", "/input/events");
          ids.add(event.id);
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
            label: input.label,
            createdAt: new Date().toISOString(),
            provenance: "client_supplied",
          },
          events: input.events.map((event, ordinal) => {
            const value = { ...event, at: event.at ?? null, ordinal, traceId };
            return { ...value, contentHash: hash(value) };
          }),
        });
        return () => {
          this.mutableReview(reviewId);
          this.store.putTrace(reviewId, retained);
          return retained.trace;
        };
      }
      case "asset.upload": {
        const assetInput = HOST_RESOURCE_COMMANDS["asset.upload"].input.parse(
          request.input,
        );
        const bytes = Buffer.from(assetInput.base64, "base64");
        if (bytes.toString("base64") !== assetInput.base64)
          invalid("Image content must use canonical base64.", "/input/base64");
        if (bytes.length > HOST_LIMITS.assetBytes)
          limit("Image exceeds the maximum retained byte size.");
        const format = imageFormat(bytes);
        if (
          !format ||
          `image/${format === "jpeg" ? "jpeg" : format}` !== assetInput.mimeType
        )
          invalid(
            "Image bytes must match the declared PNG, JPEG or WebP format.",
            "/input/mimeType",
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
              "/input/base64",
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
          invalid(
            "Image content could not be decoded safely.",
            "/input/base64",
          );
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
          this.mutableReview(reviewId);
          this.store.putAsset(reviewId, asset, bytes);
          return asset;
        };
      }
    }
  }

  query(
    request: Exclude<HostResourceQuery, { type: "map.analyze" }>,
  ): JsonValue {
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

  async analyze(input: HostMapAnalysisInput, source: LocalRepositorySource) {
    const request = HostMapAnalysisInputSchema.parse(input);
    const snapshot = this.store.reviewSnapshot(
      request.reviewId,
      request.reviewVersion,
    );
    const selection = request.mapVersions ?? snapshot.mapVersions;
    this.validateSelectedMaps(request.reviewId, snapshot.binding, selection);
    const maps = {
      base:
        selection.base === null
          ? null
          : this.store.mapVersion(request.reviewId, selection.base),
      head:
        selection.head === null
          ? null
          : this.store.mapVersion(request.reviewId, selection.head),
    };
    const patch =
      maps.base === null && maps.head === null
        ? ""
        : await source.analysisPatch(snapshot.binding);
    return analyzeMapChanges({
      request,
      binding: snapshot.binding,
      maps,
      patch,
    });
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

  validateSelectedMaps(
    reviewId: string,
    binding: HostBinding,
    mapVersions: { base: string | null; head: string | null },
  ): void {
    for (const side of ["base", "head"] as const) {
      const id = mapVersions[side];
      if (id === null) continue;
      const map = this.store.mapVersion(reviewId, id);
      const commit = side === "base" ? binding.baseCommit : binding.headCommit;
      if (map.repositoryId !== binding.repositoryId || map.commit !== commit)
        invalid(
          "Selected maps must match the review side's exact repository and commit.",
          `/input/mapVersions/${side}`,
        );
    }
  }

  private mutableReview(reviewId: string) {
    const review = this.store.review(reviewId);
    if (review.deletedAt !== null || review.state === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
  }

  private async prepareMap(
    map: HostAuthoredMap,
    repositoryId: string,
    commit: string,
    previous: Record<string, HostSourceQuote>,
  ): Promise<HostPreparedMap> {
    const authored = HostAuthoredMapSchema.parse(map);
    bounded(authored, HOST_RESOURCE_LIMITS.mapBytes, "Map");
    validateMap(authored);
    const binding: HostBinding = {
      id: randomUUID(),
      repositoryId,
      selector: { kind: "snapshot", ref: commit },
      baseCommit: commit,
      headCommit: commit,
      createdAt: new Date().toISOString(),
    };
    const retained = new Map(
      Object.values(previous)
        .filter(
          (quote) =>
            quote.span.repositoryId === repositoryId &&
            quote.span.commit === commit,
        )
        .map((quote) => [locatorKey(quote.span), quote]),
    );
    const evidence: Record<string, HostSourceQuote> = {};
    const resolve = async (locator: {
      file: string;
      fromLine: number;
      toLine: number;
    }) => {
      const key = locatorKey(locator);
      let quote = retained.get(key);
      if (!quote) {
        quote = HostSourceQuoteSchema.parse(
          await this.evidence.resolve(binding, { side: "head", ...locator }),
        );
        if (
          quote.span.repositoryId !== repositoryId ||
          quote.span.commit !== commit ||
          locatorKey(quote.span) !== key ||
          createHash("sha256").update(quote.text).digest("hex") !== quote.sha256
        )
          invalid(
            "Map evidence does not match its exact source locator.",
            "/candidate/map",
          );
        retained.set(key, quote);
      }
      evidence[hash(quote.span)] = quote;
      return quote.span;
    };
    const elements: HostMap["elements"] = {};
    for (const [id, element] of Object.entries(authored.elements)) {
      const source: HostSourceSpan[] = [];
      for (const locator of element.source) source.push(await resolve(locator));
      elements[id] = { ...element, source };
    }
    const relationships: HostMap["relationships"] = {};
    for (const [id, relationship] of Object.entries(authored.relationships))
      relationships[id] =
        relationship.kind === "call"
          ? { ...relationship, evidence: await resolve(relationship.evidence) }
          : relationship;
    const resolved = HostMapSchema.parse({
      schemaVersion: 1,
      elements,
      relationships,
    });
    bounded(resolved, HOST_RESOURCE_LIMITS.mapBytes, "Resolved map");
    bounded(
      evidence,
      HOST_RESOURCE_LIMITS.mapEvidenceBytes,
      "Retained map evidence",
    );
    return { repositoryId, commit, map: resolved, evidence };
  }
}

function applyMapOperations(
  before: HostMap,
  operations: HostAuthoredMapOperation[],
): HostAuthoredMap {
  const locator = ({ file, fromLine, toLine }: HostSourceSpan) => ({
    file,
    fromLine,
    toLine,
  });
  const map: HostAuthoredMap = {
    schemaVersion: 1,
    elements: Object.fromEntries(
      Object.entries(before.elements).map(([id, element]) => [
        id,
        { ...structuredClone(element), source: element.source.map(locator) },
      ]),
    ),
    relationships: Object.fromEntries(
      Object.entries(before.relationships).map(([id, relationship]) => [
        id,
        relationship.kind === "call"
          ? {
              ...structuredClone(relationship),
              evidence: locator(relationship.evidence),
            }
          : structuredClone(relationship),
      ]),
    ),
  };
  const writes = new Set<string>();
  for (const operation of operations) {
    const identity =
      operation.op === "element.put"
        ? `element:${operation.element.id}`
        : operation.op === "relationship.put"
          ? `relationship:${operation.relationship.id}`
          : `${operation.op.startsWith("element") ? "element" : "relationship"}:${operation.id}`;
    if (writes.has(identity))
      invalid(
        "A map transaction cannot write the same identity twice.",
        "/input/operations",
      );
    writes.add(identity);
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
          throw new HostStoreError(
            "NOT_FOUND",
            "Cannot remove a missing map element.",
          );
        delete map.elements[operation.id];
        break;
      case "relationship.remove":
        if (!Object.hasOwn(map.relationships, operation.id))
          throw new HostStoreError(
            "NOT_FOUND",
            "Cannot remove a missing map relationship.",
          );
        delete map.relationships[operation.id];
        break;
    }
  }
  return map;
}

function locatorKey(locator: {
  file: string;
  fromLine: number;
  toLine: number;
}) {
  return canonicalHostJson({
    file: locator.file,
    fromLine: locator.fromLine,
    toLine: locator.toLine,
  });
}

function validateMap(map: HostAuthoredMap): void {
  const diagnostics: HostDiagnostic[] = [];
  const issue = (path: string, message: string) => {
    if (diagnostics.length < 100)
      diagnostics.push({
        severity: "error",
        code: "INVALID_MAP",
        message,
        path: `/candidate/map${path}`,
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
    for (const [collectionId, collection] of Object.entries(
      element.store?.collections ?? {},
    )) {
      for (const [fieldId, field] of Object.entries(collection.fields)) {
        if (!field.references) continue;
        const target = field.references;
        const store = map.elements[target.storeId];
        if (
          store?.kind !== "store" ||
          !Object.hasOwn(
            store.store?.collections[target.collectionId]?.fields ?? {},
            target.fieldId,
          )
        )
          issue(
            `/elements/${id}/store/collections/${collectionId}/fields/${fieldId}/references`,
            "Field references must name an existing store, collection and field.",
          );
      }
    }
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
