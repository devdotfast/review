import { randomUUID } from "node:crypto";

import { type JsonValue, parseJsonText } from "@dev.fast/json";
import {
  MAX_SHARE_MANIFEST_BYTES,
  type ShareManifest,
  shareManifestSchema,
} from "@dev.fast/review-share-protocol";
import { z } from "zod";

import { type ShareBundle, digestBytes } from "./export.js";
import { validateShareBundle } from "./import.js";

const uploadSchema = z.strictObject({
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});

const createdSchema = z.strictObject({
  shareId: z.uuid(),
  upload: uploadSchema,
});

const linkSchema = z.strictObject({ shareId: z.uuid(), url: z.url() });

const receivedSchema = z.strictObject({
  manifest: shareManifestSchema,
  sender: z.strictObject({ login: z.string().min(1).max(256) }),
  sharedAt: z.number(),
});

const downloadSchema = z.strictObject({ url: z.url(), expiresAt: z.string() });

/** Size is checked while reading, even if Content-Length is absent or false. */
export async function readBoundedBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}).`);
  const declared = response.headers.get("content-length");

  if (declared && Number(declared) > limit) {
    await response.body.cancel();
    throw new Error("Download exceeds its declared limit.");
  }

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > limit) throw new Error("Download exceeds its declared limit.");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  return Buffer.concat(parts, size);
}

/** Account tokens go only to the configured API origin, never to object storage. */
export class ShareClient {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly token?: string,
    private readonly send: typeof fetch = fetch,
  ) {
    const url = new URL(origin);

    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "localhost"))
    )
      throw new Error("Use a secure share service origin.");
    this.origin = url.origin;
  }

  private async api(
    route: string,
    method = "GET",
    body?: JsonValue,
    capability?: string,
  ): Promise<JsonValue> {
    const headers = new Headers({ "content-type": "application/json" });

    if (capability) headers.set("x-review-share-token", capability);
    else if (this.token) headers.set("authorization", `Bearer ${this.token}`);

    const init: RequestInit = {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers,
    };

    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.send(this.origin + route, init);

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Share request failed (${response.status}).`);
    }

    return parseJsonText(
      Buffer.from(
        await readBoundedBytes(response, MAX_SHARE_MANIFEST_BYTES),
      ).toString(),
    );
  }

  private async upload(
    upload: z.infer<typeof uploadSchema>,
    bytes: Uint8Array,
  ) {
    if (new URL(upload.url).protocol !== "https:")
      throw new Error("Invalid object upload URL.");

    const response = await this.send(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: Buffer.from(bytes),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });

    // Conditional create can return 412 after a successful upload whose response
    // was lost. Completion checks the actual stored digest before publication.
    await response.body?.cancel();

    if (!response.ok && response.status !== 412)
      throw new Error(`Object upload failed (${response.status}).`);
  }

  async create(bundle: ShareBundle, requestId: string = randomUUID()) {
    validateShareBundle(bundle);
    const manifestBytes = Buffer.from(JSON.stringify(bundle.manifest));

    const created = createdSchema.parse(
      await this.api("/api/shares", "POST", {
        requestId,
        manifest: {
          size: manifestBytes.byteLength,
          sha256: digestBytes(manifestBytes),
        },
      }),
    );

    const route = `/api/shares/${created.shareId}`;
    await this.upload(created.upload, manifestBytes);
    await this.api(`${route}/manifest`, "POST", {});

    for (const object of bundle.manifest.objects) {
      const result = await this.api(
        `${route}/objects/${object.id}/upload`,
        "POST",
        {},
      );

      if (
        z.strictObject({ present: z.literal(true) }).safeParse(result).success
      )
        continue;
      await this.upload(
        uploadSchema.parse(result),
        bundle.objects.get(object.id)!,
      );
    }

    for (
      let batch = 0;
      batch <= Math.ceil(bundle.manifest.objects.length / 32);
      batch++
    ) {
      const result = await this.api(`${route}/complete`, "POST", {});

      if (linkSchema.safeParse(result).success) return linkSchema.parse(result);
      z.strictObject({ complete: z.literal(false) }).parse(result);
    }

    throw new Error("Share verification did not finish.");
  }

  async list(cursor?: string) {
    const query = cursor ? `?cursor=${z.uuid().parse(cursor)}` : "";

    return this.api(`/api/shares${query}`);
  }

  async recoverLink(shareId: string) {
    return linkSchema.parse(
      await this.api(`/api/shares/${z.uuid().parse(shareId)}/link`),
    );
  }

  async revoke(shareId: string) {
    return this.api(`/api/shares/${z.uuid().parse(shareId)}`, "DELETE");
  }

  async download(shareId: string, capability: string): Promise<ShareBundle> {
    const route = `/api/shared/${z.uuid().parse(shareId)}`;

    const received = receivedSchema.parse(
      await this.api(route, "GET", undefined, capability),
    );

    const manifest: ShareManifest = received.manifest;
    const objects = new Map<string, Uint8Array>();

    for (const object of manifest.objects) {
      const signed = downloadSchema.parse(
        await this.api(
          `${route}/objects/${object.id}`,
          "GET",
          undefined,
          capability,
        ),
      );

      if (new URL(signed.url).protocol !== "https:")
        throw new Error("Invalid object download URL.");

      const bytes = await readBoundedBytes(
        await this.send(signed.url, {
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        }),
        object.size,
      );

      if (
        bytes.byteLength !== object.size ||
        digestBytes(bytes) !== object.sha256
      )
        throw new Error("Downloaded share object failed its integrity check.");
      objects.set(object.id, bytes);
    }

    const bundle = {
      manifest,
      objects,
      attribution: {
        login: received.sender.login,
        sharedAt: received.sharedAt,
      },
    };

    // Document validation happens once at the importer boundary.

    return bundle;
  }
}
