import {
  HOST_LIMITS,
  type HostDocumentState,
  type HostMapVersion,
  type HostQueryResults,
  type ReviewClient,
} from "@dev.fast/review-protocol";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type HostDocumentResources,
  type HostImageResource,
  type HostTraceResource,
  hostNodeResource,
} from "./host-document-components";

type ResourceReference = NonNullable<ReturnType<typeof hostNodeResource>>;
type LoadedResource =
  | { kind: "map"; value: HostMapVersion }
  | { kind: "trace"; value: HostTraceResource }
  | { kind: "asset"; value: HostImageResource };
interface ResourceState {
  loaded: ReadonlyMap<string, LoadedResource>;
  errors: ReadonlyMap<string, string>;
}

/** The current document owns these resources; removed dependencies are released. */
export function useHostResources(
  client: ReviewClient,
  document: HostDocumentState | undefined,
  wasmUrl?: string,
) {
  const [state, setState] = useState<ResourceState>({
    loaded: new Map(),
    errors: new Map(),
  });
  const latest = useRef(state);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const references = new Map<string, ResourceReference>();
  for (const node of Object.values(document?.nodes ?? {})) {
    const reference = hostNodeResource(node);
    if (reference)
      references.set(`${reference.kind}:${reference.id}`, reference);
  }
  const signature = [...references.keys()].sort().join(",");
  const reviewId = document?.reviewId;
  useEffect(() => {
    const abort = new AbortController();
    const loaded = new Map(
      [...latest.current.loaded].filter(([key]) => references.has(key)),
    );
    const next: ResourceState = { loaded, errors: new Map() };
    latest.current = next;
    setState(next);
    if (!reviewId) return () => abort.abort();
    const missing = [...references.entries()].filter(
      ([key]) => !loaded.has(key),
    );
    let index = 0;
    const worker = async () => {
      while (!abort.signal.aborted) {
        const item = missing[index++];
        if (!item) return;
        const [key, reference] = item;
        try {
          const value = await loadHostResource(
            client,
            reviewId,
            reference,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          latest.current = {
            ...latest.current,
            loaded: new Map(latest.current.loaded).set(key, value),
          };
        } catch (cause) {
          if (abort.signal.aborted) return;
          latest.current = {
            ...latest.current,
            errors: new Map(latest.current.errors).set(
              key,
              cause instanceof Error ? cause.message : String(cause),
            ),
          };
        }
        setState(latest.current);
      }
    };
    // Bound concurrent resource responses/decoders, especially image buffers.
    for (
      let workerIndex = 0;
      workerIndex < Math.min(4, missing.length);
      workerIndex++
    )
      void worker();
    return () => abort.abort();
  }, [client, reviewId, signature, retryAttempt]);

  const resources = useMemo<HostDocumentResources>(() => {
    const maps: Record<string, HostMapVersion> = {};
    const traces: Record<string, HostTraceResource> = {};
    const images: Record<string, HostImageResource> = {};
    const pending = new Set<string>();
    for (const [key, reference] of references) {
      const resource = state.loaded.get(key);
      if (!resource) {
        if (!state.errors.has(key)) pending.add(key);
        continue;
      }
      switch (resource.kind) {
        case "map":
          maps[reference.id] = resource.value;
          break;
        case "trace":
          traces[reference.id] = resource.value;
          break;
        case "asset":
          images[reference.id] = resource.value;
          break;
      }
    }
    return { maps, traces, images, pending, wasmUrl };
  }, [state, signature, wasmUrl]);
  return {
    resources,
    errors: state.errors,
    retry: () => setRetryAttempt((attempt) => attempt + 1),
  };
}

export async function loadHostResource(
  client: ReviewClient,
  reviewId: string,
  reference: ResourceReference,
  signal: AbortSignal,
): Promise<LoadedResource> {
  switch (reference.kind) {
    case "map": {
      const { result } = await client.query(
        "map.get",
        { reviewId, mapVersionId: reference.id },
        signal,
      );
      if (result.id !== reference.id)
        throw new Error("The host returned a different software map.");
      return { kind: "map", value: result };
    }
    case "trace": {
      const { result } = await client.query(
        "trace.get",
        { reviewId, traceId: reference.id },
        signal,
      );
      if (
        result.trace.id !== reference.id ||
        result.events.some((event) => event.traceId !== reference.id)
      )
        throw new Error("The host returned a different retained trace.");
      return {
        kind: "trace",
        value: {
          id: result.trace.id,
          provenance: result.trace.provenance,
          label: result.trace.label,
          events: Object.fromEntries(
            result.events.map((event) => [
              event.id,
              { id: event.id, text: event.text, role: event.kind },
            ]),
          ),
        },
      };
    }
    case "asset": {
      const { result } = await client.query(
        "asset.get",
        { reviewId, assetId: reference.id },
        signal,
      );
      if (result.asset.id !== reference.id)
        throw new Error("The host returned a different image.");
      return { kind: "asset", value: await decodeHostImage(result) };
    }
  }
}

export async function decodeHostImage({
  asset,
  base64,
}: HostQueryResults["asset.get"]): Promise<HostImageResource> {
  if (
    asset.byteLength > HOST_LIMITS.assetBytes ||
    base64.length > 4 * Math.ceil(HOST_LIMITS.assetBytes / 3) ||
    asset.width * asset.height > HOST_LIMITS.assetPixels
  )
    throw new Error("The retained image exceeds the display limits.");
  const binary = atob(base64);
  if (binary.length !== asset.byteLength)
    throw new Error("The retained image length does not match its metadata.");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const hash = await crypto.subtle.digest("SHA-256", bytes.buffer);
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (sha256 !== asset.sha256)
    throw new Error("The retained image failed its integrity check.");
  return { id: asset.id, mimeType: asset.mimeType, bytes };
}
