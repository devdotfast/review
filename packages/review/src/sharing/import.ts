import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/json";
import { ReviewCommitSummarySchema } from "@dev.fast/review-protocol";
import {
  MAX_SHARE_MANIFEST_BYTES,
  type ShareManifest,
  shareIdSchema,
  shareManifestSchema,
} from "@dev.fast/review-share-protocol";
import { z } from "zod";

import { textIncludesQuote } from "../evidence.js";
import { ReviewInputError } from "../review-api/document.js";
import {
  checkReferences,
  documentSchema,
  pinsSchema,
  resourceReferences,
  sourceReferences,
} from "../review-api/document.js";
import {
  normalizedSoftwareElementSchema,
  normalizedSoftwareRelationshipSchema,
} from "../software-map-model.js";
import { sliceSourceRange } from "../source.js";
import { removeSharedRepository } from "./clone.js";
import { type ShareBundle, digestBytes } from "./export.js";

export const sharedSnapshotSchema = z.strictObject({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1),
  pins: pinsSchema.extend({
    base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  document: documentSchema,
  createdAt: z.string(),
  origin: z
    .strictObject({
      branch: z.string().optional(),
      baseRef: z.string().optional(),
      pullRequestNumber: z.number().int().positive().optional(),
      pullRequestUrl: z.string().optional(),
      revision: z.string().optional(),
    })
    .optional(),
});

const count = z.number().int().nonnegative();

const counts = z.strictObject({ additions: count, deletions: count });

const mapSchema = z.strictObject({
  commit: z.string(),
  side: z.enum(["base", "head"]),
  elements: z.array(normalizedSoftwareElementSchema),
  relationships: z.array(normalizedSoftwareRelationshipSchema),
  countsByElementPath: z.record(z.string(), counts),
  unmappedByElementPath: z.record(
    z.string(),
    counts.extend({
      files: z.array(
        counts.extend({
          file: z.string(),
          hunks: z.array(
            z.strictObject({
              startLine: count,
              lines: z.array(
                z.strictObject({
                  kind: z.enum(["add", "remove"]),
                  oldLine: count.nullable(),
                  newLine: count.nullable(),
                  text: z.string(),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const sharePresentationSchema = z.strictObject({
  commits: z.array(ReviewCommitSummarySchema),
  diffs: z.array(
    counts.extend({
      path: z.string(),
      previousPath: z.string().optional(),
      status: z.enum([
        "added",
        "deleted",
        "modified",
        "renamed",
        "copied",
        "unmerged",
        "unknown",
      ]),
      patch: z.string(),
    }),
  ),
  maps: z.record(z.string(), mapSchema),
});

const traceSchema = z.object({
  label: z.string(),
  events: z.array(
    z.strictObject({
      id: z.string(),
      role: z.enum(["user", "assistant", "tool"]),
      text: z.string(),
    }),
  ),
  provenance: z.literal("client_supplied").optional(),
});

export function validateShareBundle(bundle: ShareBundle) {
  const manifest = shareManifestSchema.parse(bundle.manifest);

  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_SHARE_MANIFEST_BYTES)
    throw new Error("Share manifest is too large.");

  if (bundle.objects.size !== manifest.objects.length)
    throw new Error("Share object count does not match its manifest.");

  for (const object of manifest.objects) {
    const bytes = bundle.objects.get(object.id);

    if (
      !bytes ||
      bytes.byteLength !== object.size ||
      digestBytes(bytes) !== object.sha256
    )
      throw new Error(`Shared object ${object.id} is missing or corrupt.`);
  }

  const json = (id: string) =>
    parseJsonText(Buffer.from(bundle.objects.get(id)!).toString());

  const snapshot = sharedSnapshotSchema.parse(json(manifest.snapshot));

  if (
    snapshot.reviewId !== manifest.reviewId ||
    snapshot.version !== manifest.version ||
    snapshot.title !== manifest.title
  )
    throw new Error("Shared snapshot does not match its manifest.");
  checkReferences(snapshot.document);

  const presentation = sharePresentationSchema.parse(
    json(manifest.presentation),
  );

  const source = (side: "base" | "head", file: string) => {
    const entry = manifest.files.find(
      (item) => item.side === side && item.file === file,
    );

    if (!entry?.object)
      throw new Error(`Missing shared source ${side}/${file}.`);

    return Buffer.from(bundle.objects.get(entry.object)!).toString();
  };

  for (const { source: range } of sourceReferences(snapshot.document))
    sliceSourceRange(source(range.side, range.file), range);

  for (const block of resourceReferences(snapshot.document)) {
    const id =
      block.type === "image"
        ? block.assetId
        : block.type === "trace_quote"
          ? block.traceId
          : block.type === "software_map"
            ? block.mapVersionId
            : undefined;

    const resource = manifest.resources.find((item) => item.id === id);

    const kind =
      block.type === "image"
        ? "image"
        : block.type === "trace_quote"
          ? "trace"
          : "map";

    if (!resource || resource.kind !== kind)
      throw new Error("Missing or mismatched shared resource.");

    if (block.type === "trace_quote") {
      const trace = traceSchema.parse(json(resource.object));

      if (
        new Set(trace.events.map((event) => event.id)).size !==
        trace.events.length
      )
        throw new Error("Duplicate shared trace event.");
      const event = trace.events.find((event) => event.id === block.eventId);

      if (!event || !textIncludesQuote(event.text, block.text))
        throw new Error("Shared quote does not match its trace.");
    }

    if (block.type === "software_map") {
      const map = presentation.maps[block.mapVersionId];

      if (!map || map.commit !== snapshot.pins[map.side])
        throw new Error("Shared map pins do not match.");

      for (const element of map.elements)
        for (const range of element.sourceRanges ?? [])
          sliceSourceRange(source(map.side, range.file), range);
    }
  }

  return { manifest, snapshot, presentation };
}

export function sharedReviewId(origin: string, shareId: string) {
  const url = new URL(origin);
  shareIdSchema.parse(shareId);

  return `shared-${digestBytes(Buffer.from(JSON.stringify([url.origin, shareId])))}`;
}

/** Separate immutable directory tree; authoring mutation handlers cannot write it. */
export class SharedReviewStore {
  private readonly loaded = new Map<string, Omit<ShareBundle, "objects">>();
  private readonly validated = new Map<
    string,
    ReturnType<typeof validateShareBundle>
  >();
  private readonly attention = new Map<
    string,
    { viewedAt: string | null; dismissedAt: string | null }
  >();
  private readonly listeners = new Set<() => void>();
  constructor(readonly root: string) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });

    for (const id of await readdir(this.root)) {
      if (!/^shared-[a-f0-9]{64}$/.test(id)) continue;
      let saved: Awaited<ReturnType<SharedReviewStore["readValidated"]>>;

      try {
        saved = await this.readValidated(id);
      } catch {
        await rename(
          path.join(this.root, id),
          path.join(this.root, `.invalid-${id}-${Date.now()}`),
        );
        console.warn(
          "A cached shared review was corrupt. Reopen its share link to download it again.",
        );
        continue;
      }

      const { bundle, validated } = saved;
      this.loaded.set(id, {
        manifest: bundle.manifest,
        attribution: bundle.attribution,
      });
      this.validated.set(id, validated);

      try {
        this.attention.set(
          id,
          z
            .strictObject({
              viewedAt: z.string().nullable(),
              dismissedAt: z.string().nullable(),
            })
            .parse(
              JSON.parse(
                await readFile(
                  path.join(this.root, id, "attention.json"),
                  "utf8",
                ),
              ),
            ),
        );
      } catch {
        /* Attention is optional local metadata. */
      }
    }
  }

  get(id: string) {
    const bundle = this.loaded.get(id);

    if (!bundle)
      throw new ReviewInputError("Shared review is not available.", 404);
    const validated = this.validated.get(id)!;

    return {
      ...validated,
      snapshot: {
        ...validated.snapshot,
        reviewId: id,
        shared: {
          ...bundle.attribution,
          cloneUrl: bundle.manifest.repository?.cloneUrl,
        },
      },
    };
  }

  list() {
    return [...this.loaded.keys()].map((id) => {
      const { document: _document, ...snapshot } = this.get(id).snapshot;

      return {
        ...snapshot,
        repositoryName: "Shared review",
        viewedAt: this.attention.get(id)?.viewedAt ?? null,
        dismissedAt: this.attention.get(id)?.dismissedAt ?? null,
      };
    });
  }

  async readObject(id: string, objectId: string) {
    const entry = this.get(id).manifest.objects.find(
      (object) => object.id === objectId,
    );

    if (!entry)
      throw new ReviewInputError("Shared object is unavailable.", 404);
    const file = path.join(this.root, id, objectId);

    if ((await stat(file)).size !== entry.size)
      throw new Error("Corrupt cached shared object.");
    const bytes = await readFile(file);

    if (digestBytes(bytes) !== entry.sha256)
      throw new Error("Corrupt cached shared object.");

    return bytes;
  }

  async removeLocal(id: string) {
    this.get(id);
    await removeSharedRepository(this, id);
    await rm(path.join(this.root, id), { recursive: true, force: true });
    this.loaded.delete(id);
    this.validated.delete(id);
    this.attention.delete(id);

    for (const listener of this.listeners) listener();
  }

  async setAttention(id: string, action: "view" | "dismiss" | "restore") {
    this.get(id);

    const state = this.attention.get(id) ?? {
      viewedAt: null,
      dismissedAt: null,
    };

    if (action === "view") state.viewedAt = new Date().toISOString();
    else
      state.dismissedAt =
        action === "dismiss" ? new Date().toISOString() : null;
    await writeFile(
      path.join(this.root, id, "attention.json"),
      JSON.stringify(state),
      { mode: 0o600 },
    );
    this.attention.set(id, state);

    for (const listener of this.listeners) listener();
  }

  async import(origin: string, shareId: string, bundle: ShareBundle) {
    const validated = validateShareBundle(bundle);
    const id = sharedReviewId(origin, shareId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(this.root, ".import-"));

    try {
      await writeFile(
        path.join(staging, "manifest.json"),
        JSON.stringify(bundle.manifest),
        { mode: 0o600 },
      );

      if (bundle.attribution)
        await writeFile(
          path.join(staging, "attribution.json"),
          JSON.stringify(bundle.attribution),
          { mode: 0o600 },
        );

      for (const [objectId, bytes] of bundle.objects)
        await writeFile(path.join(staging, objectId), bytes, { mode: 0o600 });

      try {
        await rename(staging, path.join(this.root, id));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            ["ENOTEMPTY", "EEXIST"].includes(String(error.code))
          )
        )
          throw error;
        const existing = await this.read(id);

        if (
          JSON.stringify(existing.manifest) !== JSON.stringify(bundle.manifest)
        )
          throw new Error("An immutable share changed its manifest.");
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    this.loaded.set(id, {
      manifest: bundle.manifest,
      attribution: bundle.attribution,
    });
    this.validated.set(id, validated);

    for (const listener of this.listeners) listener();

    return id;
  }

  async read(id: string): Promise<ShareBundle> {
    return (await this.readValidated(id)).bundle;
  }

  private async readValidated(id: string) {
    if (!/^shared-[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid shared review ID.");
    const dir = path.join(this.root, id);

    if (
      (await stat(path.join(dir, "manifest.json"))).size >
      MAX_SHARE_MANIFEST_BYTES
    )
      throw new Error("Shared manifest is too large.");

    const manifest: ShareManifest = shareManifestSchema.parse(
      JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")),
    );

    const objects = new Map<string, Uint8Array>();

    for (const object of manifest.objects) {
      const file = path.join(dir, object.id);

      if ((await stat(file)).size !== object.size)
        throw new Error("Corrupt cached shared object.");
      objects.set(object.id, await readFile(file));
    }

    let attribution: ShareBundle["attribution"];

    try {
      attribution = z
        .strictObject({ login: z.string(), sharedAt: z.number() })
        .parse(
          JSON.parse(
            await readFile(path.join(dir, "attribution.json"), "utf8"),
          ),
        );
    } catch {
      /* Local-only fixtures have no hosted sender. */
    }

    const bundle = { manifest, objects, attribution };
    const validated = validateShareBundle(bundle);

    return { bundle, validated };
  }
}
