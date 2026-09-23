import { randomUUID } from "node:crypto";

import { type JsonValue, parseJsonText } from "@dev.fast/json";
import {
  MAX_SHARE_MANIFEST_BYTES,
  type ShareManifest,
  importedShareManifestSchema,
} from "@dev.fast/review-share-protocol";
import { z } from "zod";

import {
  StreamLimitError,
  readBoundedStream,
} from "../server/bounded-stream.js";
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

const registeredSchema = z.object({
  registered: z.literal(true),
  uploads: z.record(z.string(), uploadSchema),
});

const UPLOAD_CONCURRENCY = 4;

// Presigned URLs and headers are larger than manifest object descriptors.
const MAX_UPLOAD_RESPONSE_BYTES = 8 * 1024 * 1024;

const linkSchema = z.strictObject({ shareId: z.uuid(), url: z.url() });

const receivedSchema = z.strictObject({
  manifest: importedShareManifestSchema,
  sender: z.strictObject({ login: z.string().min(1).max(256) }),
  sharedAt: z.number(),
});

const signedUrlSchema = z.url().refine((value) => {
  const url = new URL(value);

  return url.protocol === "https:" && !url.username && !url.password;
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
    await response.body.cancel().catch(() => {});
    throw new Error("Download exceeds its declared limit.");
  }

  try {
    return await readBoundedStream(response.body, limit);
  } catch (error) {
    if (error instanceof StreamLimitError)
      throw new Error("Download exceeds its declared limit.");
    throw error;
  }
}

/** The share service rejected the account token; the stored login is stale. */
export class ShareAuthError extends Error {
  constructor() {
    super("The share service rejected the stored login.");
    this.name = "ShareAuthError";
  }
}

export class SharePreflightError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Repository verification failed.",
      { cause },
    );
    this.name = "SharePreflightError";
  }
}

class ShareRequestError extends Error {
  constructor(readonly status: number) {
    super(`Share request failed (${status}).`);
  }
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
    maxBytes = MAX_SHARE_MANIFEST_BYTES,
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

      if (response.status === 401 && !capability) throw new ShareAuthError();
      throw new ShareRequestError(response.status);
    }

    return parseJsonText(
      Buffer.from(await readBoundedBytes(response, maxBytes)).toString(),
    );
  }

  private async upload(
    upload: z.infer<typeof uploadSchema>,
    bytes: Uint8Array,
  ) {
    if (!signedUrlSchema.safeParse(upload.url).success)
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

  async create(
    bundle: ShareBundle,
    requestId: string = randomUUID(),
    beforeUpload?: () => Promise<void>,
  ) {
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

    const { uploads } = registeredSchema.parse(
      await this.api(
        `${route}/manifest`,
        "POST",
        {},
        undefined,
        MAX_UPLOAD_RESPONSE_BYTES,
      ),
    );

    try {
      if (bundle.manifest.objects.some(({ id }) => !uploads[id]))
        throw new Error("The share service omitted an object upload URL.");

      await beforeUpload?.();
    } catch (error) {
      // A retry may recover an already published share after a lost response.
      await this.recoverLink(created.shareId)
        .catch(async (failure) => {
          if (failure instanceof ShareRequestError && failure.status === 409)
            await this.revoke(created.shareId);
        })
        .catch(() => {});
      throw new SharePreflightError(error);
    }

    for (
      let offset = 0;
      offset < bundle.manifest.objects.length;
      offset += UPLOAD_CONCURRENCY
    ) {
      const results = await Promise.allSettled(
        bundle.manifest.objects
          .slice(offset, offset + UPLOAD_CONCURRENCY)
          .map(async (object) => {
            await this.upload(
              uploads[object.id]!,
              bundle.objects.get(object.id)!,
            );
          }),
      );

      const failed = results.find((result) => result.status === "rejected");

      if (failed) throw failed.reason;
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

    const download = async (object: ShareManifest["objects"][number]) => {
      const signed = downloadSchema.parse(
        await this.api(
          `${route}/objects/${object.id}`,
          "GET",
          undefined,
          capability,
        ),
      );

      if (!signedUrlSchema.safeParse(signed.url).success)
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
    };

    for (let start = 0; start < manifest.objects.length; start += 4)
      await Promise.all(manifest.objects.slice(start, start + 4).map(download));

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
