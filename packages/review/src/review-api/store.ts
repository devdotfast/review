import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import type { ReviewApiSummary } from "@dev.fast/review-protocol";
import { z } from "zod";

import { ReviewActivity } from "./activity.js";
import {
  type Block,
  type Pins,
  ReviewInputError,
  type ReviewTarget,
  type Source,
  applyEdit,
  assignFreshIds,
  checkReferences,
  documentSchema,
  editSchema,
  elements,
  pinsSchema,
  resourceReferences,
  reviewTargetSchema,
  sourceReferences,
} from "./document.js";
import { ReviewDrafts, draftCommandSchema } from "./drafts.js";
import { pullRequestUrl, setPullRequest } from "./origin.js";

const reviewId = z.string().min(1);

export const commandSchema = z.strictObject({
  commandId: z.uuid(),
  leaseId: z.uuid().optional(),
  operation: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("delete"), reviewId }),
    z.strictObject({
      type: z.literal("attention"),
      reviewId,
      action: z.enum(["view", "dismiss", "restore"]),
    }),
    z.strictObject({
      type: z.literal("create"),
      title: z.string().trim().min(1),
      pins: pinsSchema.optional(),
      target: reviewTargetSchema.optional(),
      pullRequestUrl: pullRequestUrl.optional(),
    }),
    z.strictObject({
      type: z.literal("set_target"),
      reviewId,
      target: reviewTargetSchema,
    }),
    z.strictObject({ type: z.literal("edit"), reviewId, edit: editSchema }),
    z.strictObject({
      type: z.literal("rename"),
      reviewId,
      title: z.string().trim().min(1),
    }),
    z.strictObject({
      type: z.literal("repin"),
      reviewId,
      pins: pinsSchema,
      pullRequestUrl: pullRequestUrl.nullable().optional(),
    }),
    z.strictObject({
      type: z.literal("restore"),
      reviewId,
      version: z.number().int().nonnegative(),
    }),
  ]),
});

/** How far legacy import has got with a review; the map has its own cursor. */
export interface LegacyImportProgress {
  revision: string;
  mapRevision: string | null;
  importedAt: string;
}

/** Source identity displayed in the review header and Home, alongside immutable pins. */
export interface SnapshotOrigin {
  /** Managed tutorial; readable by ID but excluded from the user catalog. */
  tutorial?: boolean;
  branch?: string;
  baseRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  /** The legacy review revision this version was imported from. */
  revision?: string;
}

export interface Snapshot {
  shared?: { login?: string; sharedAt?: number; cloneUrl?: string };
  reviewId: string;
  version: number;
  title: string;
  pins: Pins;
  target: ReviewTarget;
  staleSources?: string[];
  sourceUnavailable?: boolean;
  document: Block[];
  createdAt: string;
  origin?: SnapshotOrigin;
}

/** A whole version written by legacy import: ids are assigned here, sources
 * are checked tolerantly, and attention is applied only for a new review. */
export interface ImportedVersionInput {
  reviewId: string;
  title: string;
  pins: Pins;
  document: Block[];
  createdAt: string;
  origin?: SnapshotOrigin;
  attention?: { viewedAt?: string | null; dismissedAt?: string | null };
}

export interface Result {
  reviewId: string;
  version: number;
  targetId?: string;
  attention?: true;
  deleted?: true;
  warnings?: string[];
}

export interface ReviewProviders {
  projectSource?(snapshot: Snapshot, pins: Pins): Promise<Snapshot>;
  resolveTarget?(
    target: ReviewTarget,
  ): Promise<{ target: ReviewTarget; pins: Pins }>;
  validatePins(pins: Pins): Promise<void>;
  validateSource(
    pins: Pins,
    source: Source,
    options: { peek: boolean },
  ): Promise<void>;
  validateResource(pins: Pins, block: Block): Promise<void>;
  /** Import only: report a problem as a warning instead of rejecting. */
  validateSourceTolerant?(
    pins: Pins,
    source: Source,
    options: { peek: boolean },
  ): Promise<string | null>;
}

/** One instance owned by the desktop server. All writers go through execute().
 * The queue includes async validation; SQLite transactions contain only writes.
 * This prototype uses a new, explicitly supplied database, never an existing profile.
 */
export class ReviewStore {
  readonly activity: ReviewActivity;
  readonly drafts: ReviewDrafts;
  private readonly db: DatabaseSync;
  private pending: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly liveSources = new Map<string, Snapshot>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshSubscribers = 0;

  watchWorktrees(): () => void {
    this.refreshSubscribers++;
    this.refreshTimer ??= setInterval(() => {
      void this.refreshWorktrees();
    }, 1000);
    this.refreshTimer.unref();

    return () => {
      if (--this.refreshSubscribers === 0) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
      }
    };
  }

  private async projectWorktree(
    snapshot: Snapshot,
    current = snapshot,
  ): Promise<Snapshot> {
    if (snapshot.target.kind !== "worktree") return snapshot;
    const { pins } = await this.providers.resolveTarget!(snapshot.target);

    if (
      JSON.stringify(current.pins) === JSON.stringify(pins) &&
      !current.sourceUnavailable
    )
      return current;

    return this.providers.projectSource
      ? this.providers.projectSource(snapshot, pins)
      : { ...snapshot, pins, sourceUnavailable: undefined };
  }

  private refreshPending: Promise<void> | undefined;

  /** Refresh source state without writing authored document versions. Serialized with edits. */
  refreshWorktrees(): Promise<void> {
    if (this.closing || !this.providers.resolveTarget) return Promise.resolve();

    if (this.refreshPending) return this.refreshPending;

    const run = this.pending.then(async () => {
      for (const summary of this.list()) {
        const snapshot = this.read(summary.reviewId, summary.version);

        if (snapshot.target.kind !== "worktree") continue;

        try {
          const last = this.read(snapshot.reviewId);
          const previous = last.pins;
          const projected = await this.projectWorktree(snapshot, last);

          if (projected === last) continue;
          this.liveSources.set(snapshot.reviewId, projected);

          if (
            JSON.stringify(previous) !== JSON.stringify(projected.pins) ||
            last.sourceUnavailable
          )
            this.notify({
              reviewId: snapshot.reviewId,
              version: snapshot.version,
            });
        } catch (error) {
          if (error instanceof ReviewInputError && error.status === 404) {
            const last = this.read(snapshot.reviewId);

            if (!last.sourceUnavailable) {
              this.liveSources.set(snapshot.reviewId, {
                ...last,
                sourceUnavailable: true,
              });
              this.notify({
                reviewId: snapshot.reviewId,
                version: snapshot.version,
              });
            }
          }
        }
      }
    });

    this.pending = run.catch(() => {});

    this.refreshPending = run.finally(() => {
      this.refreshPending = undefined;
    });

    return this.refreshPending;
  }
  private readonly listeners = new Set<(result: Result) => void>();
  private readonly catalogListeners = new Set<() => void>();
  private readonly externalChanges: ReturnType<typeof setInterval>;
  private observedDataVersion: number;
  private observedVersions = new Map<string, number>();
  subscribeCatalog(listener: () => void) {
    this.catalogListeners.add(listener);

    return () => {
      this.catalogListeners.delete(listener);
    };
  }
  subscribe(listener: (result: Result) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  constructor(
    databasePath: string,
    private readonly providers: ReviewProviders,
  ) {
    // WAL plus a busy timeout: another host on the same home waits instead of failing.
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, version INTEGER NOT NULL, next_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(review_id TEXT REFERENCES reviews(id), version INTEGER, snapshot TEXT NOT NULL,
        PRIMARY KEY(review_id,version));
      CREATE TABLE IF NOT EXISTS receipts(command_id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL);`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS review_attention(review_id TEXT PRIMARY KEY REFERENCES reviews(id), viewed_at TEXT, dismissed_at TEXT);`,
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id),
        kind TEXT NOT NULL, mime_type TEXT NOT NULL, data BLOB NOT NULL);`);
    // Import progress lives apart from the editable snapshots: restoring an
    // older version or deleting the review must not look like an unfinished
    // import to the next sweep.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS legacy_imports(review_id TEXT PRIMARY KEY, revision TEXT NOT NULL, map_revision TEXT, imported_at TEXT NOT NULL);`,
    );
    this.activity = new ReviewActivity(
      this.db,
      (id) => this.assertExists(id),
      (id) => this.drafts.assertUnlocked(id),
    );
    this.drafts = new ReviewDrafts(this.db, {
      read: (id) => this.read(id),
      assertInteractiveUnlocked: (id) => this.activity.assertWrite(id),
      validate: async (snapshot) => {
        await this.providers.validatePins(snapshot.pins);
        await this.validateExternal(snapshot);
      },
      notify: (result) => this.notify(result),
    });

    // Homes written before map resumption lack the column.
    if (
      !this.db
        .prepare("PRAGMA table_info(legacy_imports)")
        .all()
        .some((column) => String(column.name) === "map_revision")
    )
      this.db.exec("ALTER TABLE legacy_imports ADD COLUMN map_revision TEXT");

    this.observedDataVersion = this.dataVersion();
    this.observedVersions = this.currentVersions();
    this.externalChanges = setInterval(
      () => this.refreshExternalChanges(),
      250,
    );
    this.externalChanges.unref();
  }

  private dataVersion() {
    return Number(this.db.prepare("PRAGMA data_version").get()!.data_version);
  }

  private currentVersions() {
    return new Map(
      this.db
        .prepare("SELECT id,version FROM reviews")
        .all()
        .map((row) => [String(row.id), Number(row.version)]),
    );
  }

  private refreshExternalChanges() {
    const version = this.dataVersion();

    if (version === this.observedDataVersion) return;
    this.observedDataVersion = version;
    const current = this.currentVersions();
    const previous = this.observedVersions;
    this.observedVersions = current;

    for (const [reviewId, savedVersion] of current)
      if (previous.get(reviewId) !== savedVersion)
        this.notify({ reviewId, version: savedVersion });

    for (const [reviewId, savedVersion] of previous)
      if (!current.has(reviewId)) {
        this.activity.deleted(reviewId);
        this.notify({ reviewId, version: savedVersion, deleted: true });
      }

    this.activity.refresh();

    // Attention and repository/resource changes need catalog invalidation too.
    for (const listener of this.catalogListeners) {
      try {
        listener();
      } catch {
        /* Disconnected readers do not stop polling. */
      }
    }
  }
  /** The last legacy revisions imported for a review, kept after deletion. */
  legacyImport(reviewId: string): LegacyImportProgress | null {
    const row = this.db
      .prepare(
        "SELECT revision,map_revision,imported_at FROM legacy_imports WHERE review_id=?",
      )
      .get(reviewId);

    return row
      ? {
          revision: String(row.revision),
          mapRevision:
            row.map_revision === null ? null : String(row.map_revision),
          importedAt: String(row.imported_at),
        }
      : null;
  }
  recordLegacyImport(
    reviewId: string,
    progress: Omit<LegacyImportProgress, "importedAt">,
  ) {
    this.db
      .prepare(
        "INSERT INTO legacy_imports(review_id,revision,map_revision,imported_at) VALUES(?,?,?,?) ON CONFLICT(review_id) DO UPDATE SET revision=excluded.revision,map_revision=excluded.map_revision,imported_at=excluded.imported_at",
      )
      .run(
        reviewId,
        progress.revision,
        progress.mapRevision,
        new Date().toISOString(),
      );
  }
  registerRepository(root: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO repositories(id,path,name) VALUES(?,?,?)")
      .run(randomUUID(), root, root.split(/[\\/]/).at(-1)!);

    const row = this.db
      .prepare("SELECT id,name FROM repositories WHERE path=?")
      .get(root)!;

    return { id: String(row.id), name: String(row.name) };
  }
  unregisterRepository(id: string) {
    this.db
      .prepare(`DELETE FROM repositories WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM versions WHERE json_extract(snapshot,'$.pins.repositoryId')=?)
      AND NOT EXISTS (SELECT 1 FROM resources WHERE repository_id=?)`)
      .run(id, id, id);
  }
  repositoryPath(id: string) {
    const row = this.db
      .prepare("SELECT path FROM repositories WHERE id=?")
      .get(id);

    if (!row) throw new ReviewInputError("Repository is not registered.", 404);

    return String(row.path);
  }
  putResource(
    id: string,
    repositoryId: string,
    kind: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO resources(id,repository_id,kind,mime_type,data) VALUES(?,?,?,?,?)",
      )
      .run(id, repositoryId, kind, mimeType, data);
    const saved = this.resource(id);

    if (
      saved.repositoryId !== repositoryId ||
      saved.kind !== kind ||
      saved.mimeType !== mimeType ||
      !Buffer.from(saved.data).equals(data)
    )
      throw new ReviewInputError(
        "Resource ID was already used for different content.",
        409,
      );

    return { id, kind, mimeType };
  }
  resource(id: string) {
    const row = this.db.prepare("SELECT * FROM resources WHERE id=?").get(id);

    if (!row) throw new ReviewInputError("Resource not found.", 404);

    return {
      id,
      repositoryId: String(row.repository_id),
      kind: String(row.kind),
      mimeType: String(row.mime_type),
      // SAFETY: resources.data is a BLOB written by putResource; node:sqlite returns Uint8Array.
      data: row.data as Uint8Array,
    };
  }
  async close() {
    this.closing = true;
    clearInterval(this.externalChanges);
    clearInterval(this.refreshTimer);
    await this.pending;
    this.drafts.close();
    this.listeners.clear();
    this.catalogListeners.clear();
    this.activity.close();
    this.db.close();
  }
  /** The 404 check alone, without loading a snapshot. */
  assertExists(id: string) {
    if (!this.db.prepare("SELECT 1 FROM reviews WHERE id=?").get(id))
      throw new ReviewInputError("Review not found.", 404);
  }
  read(id: string, version?: number): Snapshot {
    const row =
      version === undefined
        ? this.db
            .prepare(
              "SELECT snapshot FROM versions JOIN reviews ON reviews.id=review_id AND reviews.version=versions.version WHERE reviews.id=?",
            )
            .get(id)
        : this.db
            .prepare(
              "SELECT snapshot FROM versions WHERE review_id=? AND version=?",
            )
            .get(id, version);

    if (!row) throw new ReviewInputError("Review or version not found.", 404);

    // SAFETY: versions contains only snapshots validated by execute before committing.
    const snapshot = JSON.parse(String(row.snapshot)) as Snapshot;
    snapshot.target ??= {
      kind: "commits",
      repositoryId: snapshot.pins.repositoryId,
      base: snapshot.pins.base,
      head: snapshot.pins.head,
    };
    const live = version === undefined ? this.liveSources.get(id) : undefined;

    if (
      live?.version === snapshot.version &&
      snapshot.target.kind === "worktree"
    )
      return structuredClone(live);

    return snapshot;
  }
  private readonly diffStats = new Map<
    string,
    NonNullable<ReviewApiSummary["diffStats"]>
  >();

  setDiffStats(pins: Pins, stats: NonNullable<ReviewApiSummary["diffStats"]>) {
    if (this.closing) return;
    this.diffStats.set(JSON.stringify(pins), stats);

    for (const listener of this.catalogListeners) {
      try {
        listener();
      } catch {
        /* A disconnected viewer must not block other catalog subscribers. */
      }
    }
  }

  /** Managed records are discoverable even if their preparation stamp was lost. */
  tutorialIds(): string[] {
    return this.db
      .prepare(
        `SELECT reviews.id FROM reviews JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version WHERE json_extract(versions.snapshot,'$.origin.tutorial') = 1`,
      )
      .all()
      .map((row) => String(row.id));
  }

  list(): ReviewApiSummary[] {
    // One query, and the document never leaves SQLite: every catalog watcher
    // re-lists on every command.
    return this.db
      .prepare(
        `SELECT json_remove(versions.snapshot,'$.document') AS summary,
          review_attention.viewed_at, review_attention.dismissed_at, repositories.name AS repository_name, repositories.path AS repository_path
        FROM reviews
        JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version
        LEFT JOIN review_attention ON review_attention.review_id=reviews.id
        LEFT JOIN repositories ON repositories.id=json_extract(versions.snapshot,'$.pins.repositoryId')
        WHERE COALESCE(json_extract(versions.snapshot,'$.origin.tutorial'), 0) = 0
        ORDER BY reviews.rowid`,
      )
      .all()
      .map((row) => {
        // SAFETY: versions contains only snapshots validated by execute before committing.
        const summary = JSON.parse(String(row.summary)) as Omit<
          Snapshot,
          "document"
        >;

        summary.target ??= {
          kind: "commits",
          repositoryId: summary.pins.repositoryId,
          base: summary.pins.base,
          head: summary.pins.head,
        };

        const live = this.liveSources.get(summary.reviewId);

        if (
          live?.version === summary.version &&
          summary.target.kind === "worktree"
        )
          summary.pins = live.pins;

        return {
          ...summary,
          repositoryPath: row.repository_path
            ? String(row.repository_path)
            : undefined,
          diffStats: this.diffStats.get(JSON.stringify(summary.pins)) ?? null,
          repositoryName: row.repository_name
            ? String(row.repository_name)
            : summary.pins.repositoryId,
          viewedAt: row.viewed_at ? String(row.viewed_at) : null,
          dismissedAt: row.dismissed_at ? String(row.dismissed_at) : null,
        };
      });
  }
  history(id: string) {
    return this.db
      .prepare(
        "SELECT version,json_extract(snapshot,'$.title') AS title,json_extract(snapshot,'$.createdAt') AS created_at FROM versions WHERE review_id=? ORDER BY version",
      )
      .all(id)
      .map((row) => ({
        version: Number(row.version),
        title: String(row.title),
        createdAt: String(row.created_at),
      }));
  }
  inspect(id: string, targetId?: string, version?: number) {
    const snapshot = this.read(id, version);

    return inspectSnapshot(snapshot, targetId);
  }
  /** Serialize scratch writes and commits with the host's other mutations. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Draft command boundary: parse before queueing any mutation.
  executeDraft(input: unknown) {
    if (this.closing)
      return Promise.reject(new Error("Review store is closing."));
    const command = draftCommandSchema.parse(input);
    const run = this.pending.then(() => this.drafts.execute(command));
    this.pending = run.catch(() => {});

    return run;
  }

  /** The host can seed a managed document; transport callers only supply a command. */
  execute(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Command boundary: commandSchema.parse below rejects malformed input before mutation.
    input: unknown,
    initial?: { document: Block[]; origin: SnapshotOrigin },
  ): Promise<Result> {
    if (this.closing)
      return Promise.reject(new Error("Review store is closing."));
    const command = commandSchema.parse(input);

    if (initial && command.operation.type !== "create")
      throw new ReviewInputError("Initial content requires a create command.");
    const request = JSON.stringify(initial ? { command, initial } : command);

    const run = this.pending.then(async () => {
      const receipt = this.db
        .prepare("SELECT request,response FROM receipts WHERE command_id=?")
        .get(command.commandId);

      if (receipt) {
        if (receipt.request === "null")
          throw new ReviewInputError("This command's review was deleted.", 404);

        if (
          !isDeepStrictEqual(
            JSON.parse(String(receipt.request)),
            JSON.parse(request),
          )
        )
          throw new ReviewInputError(
            "Command ID was already used for different input.",
            409,
          );

        // SAFETY: receipts stores the Result created in commitCommand, never caller-provided JSON.
        return JSON.parse(String(receipt.response)) as Result;
      }

      const op = command.operation;

      if (op.type !== "create" && op.type !== "attention") {
        this.drafts.assertUnlocked(op.reviewId);
        this.activity.assertWrite(op.reviewId, command.leaseId);
      }

      if (op.type === "create" && Boolean(op.pins) === Boolean(op.target))
        throw new ReviewInputError(
          "Supply exactly one of target or legacy pins.",
        );

      const requestedTarget =
        op.type === "create" || op.type === "set_target"
          ? op.target
          : undefined;

      const resolvedTarget = requestedTarget
        ? await this.providers.resolveTarget?.(requestedTarget)
        : undefined;

      if (requestedTarget && !resolvedTarget)
        throw new ReviewInputError("Review targets are unavailable.");

      if (op.type === "delete") {
        const result: Result = {
          reviewId: op.reviewId,
          version: this.read(op.reviewId).version,
          deleted: true,
        };

        this.commitCommand(
          command.commandId,
          request,
          result,
          () => {
            for (const table of [
              "authoring_sessions",
              "review_attention",
              "versions",
            ])
              this.db
                .prepare(`DELETE FROM ${table} WHERE review_id=?`)
                .run(op.reviewId);
            this.db.prepare("DELETE FROM reviews WHERE id=?").run(op.reviewId);
            // Keep command IDs so a delayed retry cannot recreate deleted content.
            // Erase their saved inputs while retaining the retry record.
            this.db
              .prepare(
                "UPDATE receipts SET request='null',response=? WHERE json_extract(response,'$.reviewId')=?",
              )
              .run(JSON.stringify(result), op.reviewId);
          },
          () =>
            this.assertMutation(op.reviewId, result.version, command.leaseId),
        );

        return result;
      }

      if (op.type === "attention") {
        const result: Result = {
          reviewId: op.reviewId,
          version: this.read(op.reviewId).version,
          attention: true,
        };

        this.commitCommand(command.commandId, request, result, () => {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO review_attention(review_id) VALUES(?)",
            )
            .run(op.reviewId);

          if (op.action === "view")
            this.db
              .prepare(
                "UPDATE review_attention SET viewed_at=? WHERE review_id=?",
              )
              .run(new Date().toISOString(), op.reviewId);
          else
            this.db
              .prepare(
                "UPDATE review_attention SET dismissed_at=? WHERE review_id=?",
              )
              .run(
                op.action === "dismiss" ? new Date().toISOString() : null,
                op.reviewId,
              );
        });

        return result;
      }

      const id = op.type === "create" ? randomUUID() : op.reviewId;
      const previous = op.type === "create" ? undefined : this.read(id);

      let snapshot: Snapshot =
        op.type === "create"
          ? {
              reviewId: id,
              version: 0,
              title: op.title,
              pins: resolvedTarget?.pins ?? op.pins!,
              target: resolvedTarget?.target ?? {
                kind: "commits",
                ...op.pins!,
              },
              document: [],
              createdAt: "",
            }
          : structuredClone(previous!);

      let nextId = previous
        ? Number(
            this.db.prepare("SELECT next_id FROM reviews WHERE id=?").get(id)!
              .next_id,
          )
        : 0;

      let targetId: string | undefined;

      switch (op.type) {
        case "create":
          if (initial) {
            snapshot.document = documentSchema.parse(initial.document);
            snapshot.origin = structuredClone(initial.origin);

            for (const block of snapshot.document)
              assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);
          }

          setPullRequest(snapshot, op.pullRequestUrl);
          break;
        case "rename":
          snapshot.title = op.title;
          break;
        case "set_target":
          if (snapshot.pins.repositoryId !== resolvedTarget!.pins.repositoryId)
            setPullRequest(snapshot, null);
          snapshot.staleSources = [];
          snapshot.target = resolvedTarget!.target;
          snapshot.pins = resolvedTarget!.pins;
          break;
        case "repin":
          setPullRequest(
            snapshot,
            op.pullRequestUrl ??
              (op.pullRequestUrl === null ||
              snapshot.pins.repositoryId !== op.pins.repositoryId
                ? null
                : undefined),
          );

          snapshot.staleSources = [];
          snapshot.pins = op.pins;
          snapshot.target = { kind: "commits", ...op.pins };
          break;
        case "restore":
          snapshot = this.read(id, op.version);
          break;
        case "edit":
          targetId = applyEdit(
            snapshot.document,
            op.edit,
            (prefix) => `${prefix}-${++nextId}`,
          );

          if (snapshot.staleSources?.length) {
            const oldSources = new Map(
              sourceReferences(previous!.document).map((item) => [
                item.id,
                JSON.stringify(item.source),
              ]),
            );

            const newSources = new Map(
              sourceReferences(snapshot.document).map((item) => [
                item.id,
                JSON.stringify(item.source),
              ]),
            );

            snapshot.staleSources = snapshot.staleSources.filter(
              (id) =>
                oldSources.get(id) === newSources.get(id) && newSources.has(id),
            );
          }

          break;
      }

      if (
        snapshot.target.kind === "worktree" &&
        op.type !== "restore" &&
        !resolvedTarget
      ) {
        snapshot = await this.projectWorktree(snapshot);
      }

      // Component shapes were checked at entry (or when merging a field patch).
      // Check cross-references here; do not reparse the whole stored document.
      checkReferences(snapshot.document);

      if (
        !previous ||
        JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins)
      )
        await this.providers.validatePins(snapshot.pins);

      const warnings = await this.validateExternal(
        snapshot,
        previous,
        op.type === "repin" || op.type === "set_target",
      );

      snapshot.version = previous ? previous.version + 1 : 0;
      snapshot.createdAt = new Date().toISOString();

      const result: Result = {
        reviewId: id,
        version: snapshot.version,
        targetId,
      };

      if (snapshot.staleSources?.length)
        warnings.push(
          "Some authored source ranges changed. Update their references before presenting this review.",
        );

      if (warnings.length) result.warnings = warnings;

      this.commitCommand(
        command.commandId,
        request,
        result,
        () => {
          this.db
            .prepare(
              "INSERT INTO reviews(id,version,next_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,next_id=excluded.next_id",
            )
            .run(id, snapshot.version, nextId);
          this.db
            .prepare(
              "INSERT INTO versions(review_id,version,snapshot) VALUES(?,?,?)",
            )
            .run(id, snapshot.version, JSON.stringify(snapshot));
        },
        previous
          ? () => this.assertMutation(id, previous.version, command.leaseId)
          : undefined,
      );

      return result;
    });

    this.pending = run.catch(() => {});

    return run;
  }
  private commitCommand(
    commandId: string,
    request: string,
    result: Result,
    apply: () => void,
    guard?: () => void,
  ) {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      guard?.();
      apply();
      this.db
        .prepare(
          "INSERT INTO receipts(command_id,request,response) VALUES(?,?,?)",
        )
        .run(commandId, request, JSON.stringify(result));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (result.deleted) this.activity.deleted(result.reviewId);
    this.notify(result);
  }
  private assertMutation(
    reviewId: string,
    version: number | undefined,
    leaseId?: string,
  ) {
    this.drafts.assertUnlocked(reviewId);
    this.activity.assertWrite(reviewId, leaseId);

    const current = this.db
      .prepare("SELECT version FROM reviews WHERE id=?")
      .get(reviewId);

    if ((current ? Number(current.version) : undefined) !== version)
      throw new ReviewInputError(
        "Review changed during validation. Reread it and retry the edit.",
        409,
      );
  }

  private notify(result: Result) {
    if (result.deleted) this.observedVersions.delete(result.reviewId);
    else if (!result.attention)
      this.observedVersions.set(result.reviewId, result.version);

    if (!result.attention)
      for (const listener of this.listeners)
        try {
          listener(result);
        } catch {
          // A subscriber failure must not reject the committed command.
        }

    for (const listener of this.catalogListeners)
      try {
        listener();
      } catch {
        // The saved command must remain successful if a viewer disconnects.
      }
  }
  has(reviewId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM reviews WHERE id=?").get(reviewId) !==
      undefined
    );
  }
  /** Legacy import of one version. See `importVersions`. */
  importVersion(
    input: ImportedVersionInput,
  ): Promise<{ version: number; warnings: string[] }> {
    return this.importVersions([input]);
  }
  /** Legacy import: every version is validated first, then all rows land in
   * one transaction, so a failure leaves no partial review. A new review
   * starts at version 0; an existing one continues its numbering. The last
   * input's `origin.revision` becomes the review's import cursor. */
  importVersions(
    inputs: ImportedVersionInput[],
    options: { preserveCurrent?: Snapshot; revision?: string } = {},
  ): Promise<{ version: number; warnings: string[] }> {
    if (this.closing)
      return Promise.reject(new Error("Review store is closing."));

    const reviewId = inputs[0]?.reviewId ?? options.preserveCurrent?.reviewId;

    if (!reviewId) return Promise.reject(new Error("Nothing to import."));

    if (
      inputs.some((input) => input.reviewId !== reviewId) ||
      (options.preserveCurrent && options.preserveCurrent.reviewId !== reviewId)
    )
      return Promise.reject(new Error("Import versions of one review only."));

    const run = this.pending.then(async () => {
      this.drafts.assertUnlocked(reviewId);
      this.activity.assertWrite(reviewId);

      const existing = this.db
        .prepare("SELECT version,next_id FROM reviews WHERE id=?")
        .get(reviewId);

      let nextId = existing ? Number(existing.next_id) : 0;
      let version = existing ? Number(existing.version) : -1;
      const snapshots: Snapshot[] = [];
      const warnings: string[] = [];

      for (const input of inputs) {
        const document = structuredClone(documentSchema.parse(input.document));

        for (const block of document)
          assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);
        checkReferences(document);
        await this.providers.validatePins(input.pins);

        const seen = new Set<string>();

        for (const { source, peek } of sourceReferences(document, {
          tolerant: true,
        })) {
          const key = JSON.stringify(source);

          if (seen.has(key)) continue;
          seen.add(key);

          const warning = this.providers.validateSourceTolerant
            ? await this.providers.validateSourceTolerant(input.pins, source, {
                peek: peek === true,
              })
            : null;

          if (warning) warnings.push(warning);
        }

        for (const block of resourceReferences(document))
          await this.providers.validateResource(input.pins, block);

        version += 1;

        const snapshot: Snapshot = {
          reviewId,
          version,
          title: input.title,
          pins: input.pins,
          target: { kind: "commits", ...input.pins },
          document,
          createdAt: input.createdAt,
        };

        if (input.origin) snapshot.origin = input.origin;
        snapshots.push(snapshot);
      }

      // Backfilling sealed history must not replace an edited JSON document.
      // Keep all existing version numbers and element IDs stable.
      if (existing && options.preserveCurrent) {
        if (options.preserveCurrent.version !== Number(existing.version))
          throw new ReviewInputError("Review changed during migration.", 409);
        documentSchema.parse(options.preserveCurrent.document);
        snapshots.push({ ...options.preserveCurrent, version: ++version });
      }

      const attention = inputs[0]?.attention;
      this.db.exec("BEGIN IMMEDIATE");

      try {
        this.assertMutation(
          reviewId,
          existing ? Number(existing.version) : undefined,
        );
        this.db
          .prepare(
            "INSERT INTO reviews(id,version,next_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,next_id=excluded.next_id",
          )
          .run(reviewId, version, nextId);

        for (const snapshot of snapshots)
          this.db
            .prepare(
              "INSERT INTO versions(review_id,version,snapshot) VALUES(?,?,?)",
            )
            .run(reviewId, snapshot.version, JSON.stringify(snapshot));

        if (!existing && attention)
          this.db
            .prepare(
              "INSERT INTO review_attention(review_id,viewed_at,dismissed_at) VALUES(?,?,?)",
            )
            .run(
              reviewId,
              attention.viewedAt ?? null,
              attention.dismissedAt ?? null,
            );

        const cursor = options.revision ?? inputs.at(-1)?.origin?.revision;

        // The importer records the map once it knows whether it landed.
        if (cursor)
          this.recordLegacyImport(reviewId, {
            revision: cursor,
            mapRevision: null,
          });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      this.notify({ reviewId, version });

      return { version, warnings: [...new Set(warnings)] };
    });

    this.pending = run.catch(() => {});

    return run;
  }
  private async validateExternal(
    snapshot: Snapshot,
    previous?: Snapshot,
    repin = false,
  ) {
    const warnings: string[] = [];

    const references = (document: Block[], tolerant = false) => {
      const sources = new Map<string, { source: Source; peek: boolean }>();
      const resources = new Map<string, Block>();

      const add = (source: Source, peek: boolean) => {
        const key = JSON.stringify(source);
        const kept = sources.get(key);
        sources.set(key, { source, peek: peek || (kept?.peek ?? false) });
      };

      for (const { source, peek } of sourceReferences(document, { tolerant }))
        add(source, peek === true);

      for (const block of resourceReferences(document))
        resources.set(JSON.stringify(block), block);

      return { sources, resources };
    };

    const current = references(snapshot.document, repin);

    // Stored content is not re-validated: an edit may fix a link that the
    // current rules reject.
    const pinsChanged =
      previous &&
      JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins);

    const worktreeMoved = pinsChanged && snapshot.target.kind === "worktree";
    const retained = references(previous?.document ?? [], true);

    // Independent reads of immutable commits: run them concurrently.
    const checks: Promise<void>[] = [];

    for (const [key, { source, peek }] of current.sources) {
      const kept = retained.sources.get(key);

      // A range validated earlier as a prose link still needs the peek check
      // the first time a code peek points at it.
      if (pinsChanged || !kept || (peek && !kept.peek))
        checks.push(
          this.providers.validateSource(snapshot.pins, source, { peek }).then(
            () => {
              if (repin)
                warnings.push(
                  `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: source pins changed; verify that this range still supports the document.`,
                );
            },
            (error) => {
              if (
                (!repin && !(worktreeMoved && kept)) ||
                !(error instanceof ReviewInputError)
              )
                throw error;
              warnings.push(
                `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: ${error.message}`,
              );
            },
          ),
        );
    }

    for (const [key, block] of current.resources)
      if (pinsChanged || !retained.resources.has(key))
        checks.push(
          this.providers
            .validateResource(snapshot.pins, block)
            .catch((error) => {
              if (
                (!repin && !(worktreeMoved && retained.resources.has(key))) ||
                !(error instanceof ReviewInputError)
              )
                throw error;
              warnings.push(`${block.id} (${block.type}): ${error.message}`);
            }),
        );

    await Promise.all(checks);

    return warnings.sort();
  }
}

export function inspectSnapshot(snapshot: Snapshot, targetId?: string) {
  if (targetId !== undefined) {
    const target = elements(snapshot.document).find(
      (element) => element.id === targetId,
    );

    if (!target)
      throw new ReviewInputError("Target not found in this version.", 404);

    return target;
  }

  return elements(snapshot.document).map((element) => ({
    id: element.id,
    type: element.type,
    label:
      "title" in element
        ? element.title
        : "label" in element
          ? element.label
          : element.type === "markdown"
            ? element.markdown.slice(0, 120)
            : undefined,
  }));
}
