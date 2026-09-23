import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parseJsonText } from "@dev.fast/json";
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@dev.fast/whiteboard-protocol";
import {
  MAX_SHARE_MANIFEST_BYTES,
  type ShareManifest,
  importedShareManifestSchema,
  shareIdSchema,
} from "@dev.fast/whiteboard-share-protocol";
import { z } from "zod";

import { textIncludesQuote } from "../evidence.js";
import { lensSchema } from "../session-api/diff-lenses.js";
import { SessionInputError } from "../session-api/document.js";
import {
  checkReferences,
  documentSchema,
  pinsSchema,
  resourceReference,
  resourceReferences,
  sourceReferences,
} from "../session-api/document.js";
import type { LocalSessionData } from "../session-api/local-data.js";
import type { SessionStore } from "../session-api/store.js";
import { traceSchema } from "../session-api/trace-schema.js";
import {
  normalizedSoftwareElementSchema,
  normalizedSoftwareRelationshipSchema,
} from "../software-map-model.js";
import { migrateDocumentLinks } from "../source-link-migration.js";
import {
  liftFileLenses,
  migrateStoredDocument,
} from "../stored-document-migration.js";
import { type ShareBundle, digestBytes } from "./export.js";
import {
  fetchPinnedRepository,
  repositoryReady,
  sharedGit,
} from "./repository.js";

export const sharedSnapshotSchema = z.strictObject({
  sessionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1),
  pins: pinsSchema.extend({
    base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  }),
  document: documentSchema,
  lenses: z.array(lensSchema).optional(),
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
  maps: z.record(z.string(), mapSchema),
});

export function validateShareBundle(bundle: ShareBundle) {
  const manifest = importedShareManifestSchema.parse(bundle.manifest);

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

  const stored = upgradeSharedId(json(manifest.snapshot));

  // Bundles shared before a field was retired still open; the bytes stay
  // sealed and only the parsed document drops the retired form. Lenses
  // shared as document blocks read as the snapshot's lenses.
  const snapshot = sharedSnapshotSchema.parse(
    isJsonObject(stored) && "document" in stored
      ? liftSharedLenses(
          stored,
          migrateDocumentLinks(migrateStoredDocument(stored.document)),
        )
      : stored,
  );

  if (
    snapshot.sessionId !== manifest.sessionId ||
    snapshot.version !== manifest.version ||
    snapshot.title !== manifest.title
  )
    throw new Error("Shared snapshot does not match its manifest.");
  checkReferences(snapshot.document);

  const presentation = sharePresentationSchema.parse(
    json(manifest.presentation),
  );

  const traces = new Map<
    string,
    Map<string, z.infer<typeof traceSchema>["events"][number]>
  >();

  for (const block of resourceReferences(snapshot.document)) {
    const reference = resourceReference(block);

    const resource = manifest.resources.find(
      (item) => item.id === reference?.id,
    );

    if (!reference || !resource || resource.kind !== reference.kind)
      throw new Error("Missing or mismatched shared resource.");

    if (block.type === "trace_quote") {
      let events = traces.get(resource.object);

      if (!events) {
        const trace = traceSchema.parse(json(resource.object));
        events = new Map(trace.events.map((event) => [event.id, event]));

        if (events.size !== trace.events.length)
          throw new Error("Duplicate shared trace event.");
        traces.set(resource.object, events);
      }

      const event = events.get(block.eventId);

      if (!event || !textIncludesQuote(event.text, block.text))
        throw new Error("Shared quote does not match its trace.");
    }

    if (block.type === "software_map") {
      const map = presentation.maps[block.mapVersionId];

      if (!map || map.commit !== snapshot.pins[map.side])
        throw new Error("Shared map pins do not match.");
    }
  }

  return { manifest, snapshot, presentation };
}

function liftSharedLenses(stored: JsonObject, migrated: JsonValue): JsonObject {
  const { document, lenses } = liftFileLenses(migrated);

  return {
    ...stored,
    document,
    ...(lenses.length && {
      lenses: [
        ...(Array.isArray(stored.lenses) ? stored.lenses : []),
        ...lenses,
      ],
    }),
  };
}

export function sharedSessionId(origin: string, shareId: string) {
  const url = new URL(origin);
  shareIdSchema.parse(shareId);

  return `shared-${digestBytes(Buffer.from(JSON.stringify([url.origin, shareId])))}`;
}

/** Separate immutable directory tree; authoring mutation handlers cannot write it. */
export class SharedSessionStore {
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
  private catalogLoaded = false;
  private readonly downloads = new Set<Promise<void>>();

  trackImport(job: Promise<void>) {
    this.downloads.add(job);
    void job.finally(() => this.downloads.delete(job));
  }

  async close() {
    await Promise.allSettled([...this.downloads, ...this.jobs.values()]);
  }

  private local?: { store: SessionStore; data: LocalSessionData };
  private readonly repositories = new Map<string, string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly states = new Map<
    string,
    {
      stage: "downloading" | "fetching" | "validating" | "ready" | "error";
      error?: string;
    }
  >();

  constructor(
    readonly root: string,
    private readonly fetchRepository = fetchPinnedRepository,
  ) {}

  connect(store: SessionStore, data: LocalSessionData) {
    this.local = { store, data };
    data.workspaces.attachExternalWhiteboards({
      has: (id) =>
        this.has(id) || (!this.catalogLoaded && id.startsWith("shared-")),
      subscribe: (listener) => this.subscribe(listener),
    });
  }

  has(id: string) {
    return this.loaded.has(id);
  }

  status(id: string) {
    return (
      this.states.get(id) ?? {
        stage: "error" as const,
        error: "Shared session is not available.",
      }
    );
  }

  setStatus(
    id: string,
    stage: "downloading" | "fetching" | "validating" | "ready" | "error",
    error?: string,
  ) {
    this.states.set(id, { stage, error });

    for (const listener of this.listeners) listener();
  }

  repositoryRoot(id: string) {
    if (!/^shared-[a-f0-9]{64}$/.test(id))
      throw new SessionInputError("Invalid shared session ID.");

    return path.join(this.root, ".repositories", id);
  }

  async prepare(id: string): Promise<void> {
    const active = this.jobs.get(id);

    if (active) return active;
    const job = this.prepareRepository(id).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);

    return job;
  }

  private async prepareRepository(id: string) {
    const local = this.local;

    if (!local)
      throw new SessionInputError("Repository service is unavailable.", 409);
    const saved = this.validated.get(id);

    if (!saved)
      throw new SessionInputError("Shared session is not available.", 404);
    const root = this.repositoryRoot(id);

    try {
      this.setStatus(id, "fetching");

      if (!(await repositoryReady(root, saved.snapshot.pins))) {
        const prior = this.repositories.get(id);
        await local.data.workspaces.remove(id);

        if (prior) await local.data.forgetRepository(prior);
        await rm(root, { recursive: true, force: true });
        await this.fetchRepository(
          root,
          saved.manifest.repository.cloneUrl,
          saved.snapshot.pins,
        );
        await sharedGit(root, [
          "checkout",
          "--detach",
          saved.snapshot.pins.head,
        ]);
      }

      const repository = await local.data.register(root);
      this.repositories.set(id, repository.id);
      await writeFile(
        path.join(this.root, id, "repository.json"),
        JSON.stringify({ repositoryId: repository.id, ready: false }),
        { mode: 0o600 },
      );
      const pins = { ...saved.snapshot.pins, repositoryId: repository.id };
      this.setStatus(id, "validating");
      await local.data.validatePins(pins);

      const references = sourceReferences(saved.snapshot.document).map(
        (item) => item.source,
      );

      for (const map of Object.values(saved.presentation.maps))
        for (const element of map.elements)
          for (const range of element.sourceRanges ?? [])
            references.push({ ...range, side: map.side });

      await local.data.validateSources(pins, references);
      await local.data.workspaces.open(id, pins);

      if (
        local.data.workspaces.list(id).some((workspace) => !workspace.rootPath)
      )
        throw new SessionInputError(
          "Could not prepare the pinned checkout. Retry opening the share.",
          409,
        );
      await writeFile(
        path.join(this.root, id, "repository.json"),
        JSON.stringify({ repositoryId: repository.id, ready: true }),
        { mode: 0o600 },
      );
      this.setStatus(id, "ready");
    } catch (error) {
      const message =
        error instanceof SessionInputError
          ? error.message
          : "Could not prepare the shared repository. Check Git credentials and retry.";

      this.setStatus(id, "error", message);
      throw new SessionInputError(message, 409);
    }
  }

  async assertReady(id: string) {
    const saved = this.validated.get(id);

    if (
      !saved ||
      !(await repositoryReady(this.repositoryRoot(id), saved.snapshot.pins))
    ) {
      this.setStatus(
        id,
        "error",
        "The managed checkout is missing. Reopen the share link to fetch it again.",
      );
      throw new SessionInputError(this.status(id).error!, 409);
    }

    this.get(id);
  }

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
      let saved: Awaited<ReturnType<SharedSessionStore["readValidated"]>>;

      try {
        saved = await this.readValidated(id);
      } catch {
        await rename(
          path.join(this.root, id),
          path.join(this.root, `.invalid-${id}-${Date.now()}`),
        );
        console.warn(
          "A cached shared session was corrupt. Reopen its share link to download it again.",
        );
        continue;
      }

      const { bundle, validated } = saved;
      this.loaded.set(id, {
        manifest: bundle.manifest,
        attribution: bundle.attribution,
      });
      this.validated.set(id, validated);

      let prepared = false;

      try {
        const metadata = z
          .strictObject({ repositoryId: z.string(), ready: z.boolean() })
          .parse(
            JSON.parse(
              await readFile(
                path.join(this.root, id, "repository.json"),
                "utf8",
              ),
            ),
          );

        if (
          this.local?.store.repositoryPath(metadata.repositoryId) ===
          path.join(await realpath(this.root), ".repositories", id)
        ) {
          this.repositories.set(id, metadata.repositoryId);
          prepared = metadata.ready;
        }
      } catch {
        /* A first or interrupted import has no local registration yet. */
      }

      if (
        prepared &&
        this.local &&
        (await repositoryReady(
          this.repositoryRoot(id),
          validated.snapshot.pins,
        ))
      ) {
        const repository = await this.local.data.register(
          this.repositoryRoot(id),
        );

        this.repositories.set(id, repository.id);
        this.setStatus(id, "ready");
      } else
        this.setStatus(
          id,
          "error",
          "Reopen the share link to fetch its repository.",
        );

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

    this.catalogLoaded = true;

    for (const listener of this.listeners) listener();
  }

  get(id: string) {
    const bundle = this.loaded.get(id);

    if (!bundle)
      throw new SessionInputError("Shared session is not available.", 404);
    const validated = this.validated.get(id)!;
    const repositoryId = this.repositories.get(id);

    if (
      !repositoryId ||
      this.status(id).stage !== "ready" ||
      !existsSync(path.join(this.repositoryRoot(id), ".git"))
    )
      throw new SessionInputError(
        this.status(id).error ??
          "Fetch the shared repository before opening this review.",
        409,
      );

    return {
      ...validated,
      snapshot: {
        ...validated.snapshot,
        sessionId: id,
        pins: { ...validated.snapshot.pins, repositoryId },
        target: {
          kind: "commits" as const,
          ...validated.snapshot.pins,
          repositoryId,
        },
        shared: {
          ...bundle.attribution,
          cloneUrl: bundle.manifest.repository?.cloneUrl,
        },
      },
    };
  }

  list(mode: "structural" | "textual" = "structural") {
    const whiteboards = this.loaded
      .keys()
      .filter(
        (id) =>
          this.status(id).stage === "ready" &&
          existsSync(path.join(this.repositoryRoot(id), ".git")),
      )
      .map((id) => {
        const { document: _document, ...snapshot } = this.get(id).snapshot;

        return {
          ...snapshot,
          firstCreatedAt:
            snapshot.version === 0 ? snapshot.createdAt : undefined,
          repositoryName: "Shared review",
          viewedAt: this.attention.get(id)?.viewedAt ?? null,
          dismissedAt: this.attention.get(id)?.dismissedAt ?? null,
        };
      })
      .toArray();

    return this.local?.store.withDiffStats(whiteboards, mode) ?? whiteboards;
  }

  async readObject(id: string, objectId: string) {
    const entry = this.get(id).manifest.objects.find(
      (object) => object.id === objectId,
    );

    if (!entry)
      throw new SessionInputError("Shared object is unavailable.", 404);
    const file = path.join(this.root, id, objectId);

    if ((await stat(file)).size !== entry.size)
      throw new Error("Corrupt cached shared object.");
    const bytes = await readFile(file);

    if (digestBytes(bytes) !== entry.sha256)
      throw new Error("Corrupt cached shared object.");

    return bytes;
  }

  async removeLocal(id: string) {
    await this.jobs.get(id)?.catch(() => {});

    if (!this.loaded.has(id))
      throw new SessionInputError("Shared session is not available.", 404);
    await this.local?.data.workspaces.remove(id);
    const repositoryId = this.repositories.get(id);

    if (repositoryId) {
      await this.local?.data.forgetRepository(repositoryId);
      this.local?.store.unregisterRepository(repositoryId);
    }

    await rm(this.repositoryRoot(id), { recursive: true, force: true });
    this.repositories.delete(id);
    this.states.delete(id);
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
    const id = sharedSessionId(origin, shareId);
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

    await this.prepare(id);

    return id;
  }

  async read(id: string): Promise<ShareBundle> {
    return (await this.readValidated(id)).bundle;
  }

  private async readValidated(id: string) {
    if (!/^shared-[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid shared session ID.");
    const dir = path.join(this.root, id);

    if (
      (await stat(path.join(dir, "manifest.json"))).size >
      MAX_SHARE_MANIFEST_BYTES
    )
      throw new Error("Shared manifest is too large.");

    const manifest: ShareManifest = importedShareManifestSchema.parse(
      upgradeSharedId(
        JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")),
      ),
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

/** Old published bytes stay immutable; normalize only their owned envelope on import. */
function upgradeSharedId(value: JsonValue): JsonValue {
  if (!isJsonObject(value) || !("reviewId" in value)) return value;

  if ("sessionId" in value)
    throw new Error("Shared data has conflicting session identifiers.");
  const { reviewId, ...rest } = value;

  return { ...rest, sessionId: reviewId };
}
