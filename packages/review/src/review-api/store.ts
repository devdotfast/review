import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { resolveRepoContextSync } from "@dev.fast/local-vcs";
import {
  SCRATCHPAD_SESSION_ID,
  type SessionSummary,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { sourceAnchors } from "../lens-selection.js";
import {
  liftFileLenses,
  migrateStoredDocument,
} from "../stored-document-migration.js";
import {
  type Coverage,
  coverageSchema,
  emptyCoverage,
  updateCoverage,
} from "../viewed-coverage.js";
import { type LeaseScope, SessionActivity } from "./activity.js";
import {
  type Lens,
  applyLensEdit,
  lensEditSchema,
  lensSelections,
} from "./diff-lenses.js";
import {
  type Applied,
  type Block,
  type EditSummary,
  type Element,
  type FileLineRange,
  type Pins,
  SessionInputError,
  type SessionTarget,
  type WrittenComponent,
  anchorPins,
  applyEdit,
  assignFreshIds,
  checkReferences,
  documentSchema,
  editSchema,
  elements,
  explicitPins,
  isUnit,
  pinsSchema,
  resourceReferences,
  sessionTargetSchema,
  sourceReferences,
  summarizeEdit,
} from "./document.js";
import { pullRequestKey, pullRequestUrl, setPullRequest } from "./origin.js";
import { migrateSessionStorage } from "./session-storage-migration.js";

const sessionId = z.string().min(1);

/** There is one scratchpad. Its id is fixed so a skill can name it. */
export const SCRATCHPAD_ID = SCRATCHPAD_SESSION_ID;

const DIAGRAM_TYPES = new Set([
  "sequence",
  "flow_diagram",
  "call_stack_diff",
  "database_lens",
  "software_map",
]);

export const SCRATCHPAD_TITLE = "Scratchpad";

/** The create command that makes it, with one id so a repeat is a receipt. */
const SCRATCHPAD_COMMAND_ID = "5c7a7c6e-0000-4000-8000-5c7a7c6e0000";

export const commandSchema = z.strictObject({
  commandId: z.uuid(),
  leaseId: z.uuid().optional(),
  operation: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("delete"), sessionId }),
    z.strictObject({
      type: z.literal("attention"),
      sessionId,
      action: z.enum(["view", "dismiss", "restore"]),
    }),
    z.strictObject({
      type: z.literal("create"),
      /** Required unless pullRequestUrl alone names the source; then the PR title. */
      title: z.string().trim().min(1).optional(),
      pins: pinsSchema.optional(),
      target: sessionTargetSchema.optional(),
      pullRequestUrl: pullRequestUrl.optional(),
      /** With pullRequestUrl and no target: the checkout to fetch the PR into. */
      repositoryId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only with pullRequestUrl and no target: the registered checkout to fetch the PR into. Default: the existing review's, else the first registered checkout with a remote for the PR's repository.",
        ),
      /** Return the existing review for pullRequestUrl instead of creating one. */
      reuseExisting: z
        .boolean()
        .optional()
        .describe(
          "Default true: return the existing review for pullRequestUrl. false creates a separate review.",
        ),
      /** The one scratchpad: no target, no pins; every reference names its own. */
      kind: z.literal("scratchpad").optional(),
    }),
    z.strictObject({
      type: z.literal("set_target"),
      sessionId,
      target: sessionTargetSchema,
    }),
    z.strictObject({ type: z.literal("edit"), sessionId, edit: editSchema }),
    z.strictObject({
      type: z.literal("lens"),
      sessionId,
      edit: lensEditSchema,
    }),
    z.strictObject({
      type: z.literal("rename"),
      sessionId,
      title: z.string().trim().min(1),
    }),
    z.strictObject({
      type: z.literal("repin"),
      sessionId,
      pins: pinsSchema,
      pullRequestUrl: pullRequestUrl.nullable().optional(),
    }),
    z.strictObject({
      type: z.literal("restore"),
      sessionId,
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
  sessionId: string;
  version: number;
  title: string;
  /** Absent for a review. The scratchpad has no pins, target or lifecycle. */
  kind?: "scratchpad";
  /** The default pins for references that name none. A document whose
   * references all carry their own pins has neither pins nor target. */
  pins?: Pins;
  target?: SessionTarget;
  staleSources?: string[];
  sourceUnavailable?: boolean;
  document: Block[];
  /** The Diff view's lenses, beside the document and versioned with it.
   * Absent on a version with none. */
  lenses?: Lens[];
  createdAt: string;
  origin?: SnapshotOrigin;
  /** The edit that produced this version, when one did; absent for a
   * rename, repin, restore or import, which the canvas does not draw. */
  lastEdit?: EditSummary;
}

/** A whole version written by legacy import: ids are assigned here, sources
 * are checked tolerantly, and attention is applied only for a new review. */
export interface ImportedVersionInput {
  sessionId: string;
  title: string;
  pins: Pins;
  document: Block[];
  createdAt: string;
  origin?: SnapshotOrigin;
  attention?: { viewedAt?: string | null; dismissedAt?: string | null };
}

export interface Result {
  /** Create only: false when an existing review for the same PR came back. */
  created?: boolean;
  /** Why an existing review came back, and what to do next, in words. */
  note?: string;
  sessionId: string;
  version: number;
  /** The existing review's stored target; the requested one is not applied. */
  target?: SessionTarget;
  /** The requested head differs from the existing review's. */
  headMoved?: boolean;
  /** A live authoring lease that is not the caller's. */
  ownedBy?: "another session";
  /** Older sessions that also name the PR, newest first. */
  otherReviewIds?: string[];
  /** The component an edit landed on, its type, and — for an insert or
   * replace — its first-level children with their fresh IDs. */
  targetId?: string;
  type?: Element["type"] | "lens";
  children?: WrittenComponent[];
  attention?: true;
  deleted?: true;
  warnings?: string[];
}

/** A PR's current comparison: GitHub's head and diff base, fetched locally. */
export interface ResolvedPullRequest {
  target: SessionTarget;
  pins: Pins;
  title: string;
}

export interface SessionProviders {
  headBranch?(pins: Pins, headRef?: string): Promise<string | undefined>;
  projectSource?(snapshot: Snapshot, pins: Pins): Promise<Snapshot>;
  /** Fetch a PR into a registered checkout: the named one, else the first
   * preferred one that still matches, else any whose remote is the PR's. */
  resolvePullRequest?(
    url: string,
    repository: { id?: string; preferred?: string },
  ): Promise<ResolvedPullRequest>;
  resolveTarget?(
    target: SessionTarget,
  ): Promise<{ target: SessionTarget; pins: Pins }>;
  /** Rejects with a 404 SessionInputError when the snapshot's checkout is gone.
   * Resolves undefined for a document without default pins. */
  sourcePins?(snapshot: Snapshot): Promise<Pins | undefined>;
  /** Ids of references whose own pins no longer name a usable checkout. */
  unavailableAnchors?(snapshot: Snapshot): Promise<string[]>;
  validatePins(pins: Pins): Promise<void>;
  validateSource(
    pins: Pins,
    source: FileLineRange,
    options: { peek: boolean },
  ): Promise<void>;
  validateResource(pins: Pins | undefined, block: Block): Promise<void>;
  /** Import only: report a problem as a warning instead of rejecting. */
  validateSourceTolerant?(
    pins: Pins,
    source: FileLineRange,
    options: { peek: boolean },
  ): Promise<string | null>;
}

/** One instance owned by the desktop server. All writers go through execute().
 * The queue includes async validation; SQLite transactions contain only writes.
 * This prototype uses a new, explicitly supplied database, never an existing profile.
 */
export class SessionStore {
  readonly activity: SessionActivity;
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

  private async projectLiveSource(
    snapshot: Snapshot,
    current = snapshot,
  ): Promise<Snapshot> {
    if (snapshot.target?.kind !== "worktree") {
      await this.providers.sourcePins?.(snapshot);

      // References with their own pins go unavailable one at a time.
      const unavailable =
        (await this.providers.unavailableAnchors?.(snapshot)) ?? [];

      const stale = [
        ...new Set([...(snapshot.staleSources ?? []), ...unavailable]),
      ];

      const staleChanged =
        JSON.stringify(stale) !== JSON.stringify(current.staleSources ?? []);

      if (!current.sourceUnavailable && !staleChanged) return current;
      const projected = { ...current, sourceUnavailable: undefined };

      if (stale.length) projected.staleSources = stale;
      else delete projected.staleSources;

      return projected;
    }

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
        const snapshot = this.read(summary.sessionId, summary.version);

        try {
          const live = this.liveSources.get(summary.sessionId);
          const last = live?.version === snapshot.version ? live : snapshot;
          const previous = last.pins;
          const projected = await this.projectLiveSource(snapshot, last);

          if (projected === last) continue;
          this.liveSources.set(snapshot.sessionId, projected);

          if (
            JSON.stringify(previous) !== JSON.stringify(projected.pins) ||
            JSON.stringify(last.staleSources ?? []) !==
              JSON.stringify(projected.staleSources ?? []) ||
            last.sourceUnavailable
          )
            this.notify({
              sessionId: snapshot.sessionId,
              version: snapshot.version,
            });
        } catch (error) {
          if (error instanceof SessionInputError && error.status === 404) {
            const last = this.read(snapshot.sessionId);

            if (!last.sourceUnavailable) {
              this.liveSources.set(snapshot.sessionId, {
                ...last,
                sourceUnavailable: true,
              });
              this.notify({
                sessionId: snapshot.sessionId,
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
  /** For a host whose listing changed without the store: a preference flip. */
  invalidateCatalog(): void {
    for (const listener of this.catalogListeners)
      try {
        listener();
      } catch {
        // A disconnected viewer must not block other catalog subscribers.
      }
  }
  subscribe(listener: (result: Result) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  constructor(
    databasePath: string,
    private readonly providers: SessionProviders,
  ) {
    // WAL plus a busy timeout: another host on the same home waits instead of failing.
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.db.exec("PRAGMA foreign_keys=ON");

    try {
      migrateSessionStorage(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, version INTEGER NOT NULL, next_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(session_id TEXT REFERENCES sessions(id), version INTEGER, snapshot TEXT NOT NULL,
        PRIMARY KEY(session_id,version));
      CREATE TABLE IF NOT EXISTS receipts(command_id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL);`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS session_attention(session_id TEXT PRIMARY KEY REFERENCES sessions(id), viewed_at TEXT, dismissed_at TEXT);`,
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id),
        kind TEXT NOT NULL, mime_type TEXT NOT NULL, data BLOB NOT NULL);`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS session_coverage(session_id TEXT REFERENCES sessions(id), file TEXT, fingerprint TEXT NOT NULL, coverage TEXT NOT NULL, PRIMARY KEY(session_id,file));",
    );
    this.db.exec("DROP TABLE IF EXISTS review_viewed");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS comparison_stats(identity TEXT PRIMARY KEY, stats TEXT NOT NULL)",
    );
    // Import progress lives apart from the editable snapshots: restoring an
    // older version or deleting the review must not look like an unfinished
    // import to the next sweep.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS legacy_imports(session_id TEXT PRIMARY KEY, revision TEXT NOT NULL, map_revision TEXT, imported_at TEXT NOT NULL);`,
    );
    // Batch authoring's scratch drafts were removed; drop their leftover table.
    this.db.exec("DROP TABLE IF EXISTS authoring_drafts");
    this.activity = new SessionActivity(this.db, (id) => this.assertExists(id));

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
        .prepare("SELECT id,version FROM sessions")
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

    for (const [sessionId, savedVersion] of current)
      if (previous.get(sessionId) !== savedVersion)
        this.notify({ sessionId, version: savedVersion });

    for (const [sessionId, savedVersion] of previous)
      if (!current.has(sessionId)) {
        this.activity.deleted(sessionId);
        this.notify({ sessionId, version: savedVersion, deleted: true });
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
  /** Reader progress never creates a document version or authoring event. */
  viewedCoverage(
    sessionId: string,
  ): Map<string, { fingerprint: string; coverage: Coverage }> {
    this.assertExists(sessionId);

    return new Map(
      this.db
        .prepare(
          "SELECT file,fingerprint,coverage FROM session_coverage WHERE session_id=?",
        )
        .all(sessionId)
        .map((row) => [
          String(row.file),
          {
            fingerprint: String(row.fingerprint),
            coverage: coverageSchema.parse(JSON.parse(String(row.coverage))),
          },
        ]),
    );
  }
  updateViewedCoverage(
    sessionId: string,
    files: { path: string; fingerprint: string; scope: Coverage }[],
    viewed: boolean,
  ): void {
    this.assertExists(sessionId);
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const current = this.viewedCoverage(sessionId);

      for (const file of files) {
        const previous = current.get(file.path);

        const coverage = updateCoverage(
          previous?.fingerprint === file.fingerprint
            ? previous.coverage
            : emptyCoverage(),
          file.scope,
          viewed,
        );

        this.db
          .prepare(
            "INSERT OR REPLACE INTO session_coverage(session_id,file,fingerprint,coverage) VALUES(?,?,?,?)",
          )
          .run(
            sessionId,
            file.path,
            file.fingerprint,
            JSON.stringify(coverage),
          );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** The last legacy revisions imported for a review, kept after deletion. */
  legacyImport(sessionId: string): LegacyImportProgress | null {
    const row = this.db
      .prepare(
        "SELECT revision,map_revision,imported_at FROM legacy_imports WHERE session_id=?",
      )
      .get(sessionId);

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
    sessionId: string,
    progress: Omit<LegacyImportProgress, "importedAt">,
  ) {
    this.db
      .prepare(
        "INSERT INTO legacy_imports(session_id,revision,map_revision,imported_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,map_revision=excluded.map_revision,imported_at=excluded.imported_at",
      )
      .run(
        sessionId,
        progress.revision,
        progress.mapRevision,
        new Date().toISOString(),
      );
  }
  private readonly repositoryGroups = new Map<
    string,
    SessionSummary["repositoryGroup"]
  >();

  private repositoryGroup(root: string): SessionSummary["repositoryGroup"] {
    if (this.repositoryGroups.has(root)) return this.repositoryGroups.get(root);

    const context = resolveRepoContextSync(root);

    if (!context) return undefined;

    const group = context.githubSlug
      ? {
          key: `remote:https://github.com/${context.githubSlug.toLowerCase()}.git`,
          label: context.githubSlug,
        }
      : {
          key: `git:${context.commonDir}`,
          label: path.basename(path.dirname(context.commonDir)),
        };

    this.repositoryGroups.set(root, group);

    return group;
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
      // Document pins and per-reference pins both spell the id in the snapshot.
      .prepare(`DELETE FROM repositories WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM versions WHERE instr(snapshot, ?) > 0)
      AND NOT EXISTS (SELECT 1 FROM resources WHERE repository_id=?)`)
      .run(id, `"repositoryId":${JSON.stringify(id)}`, id);
  }
  /** Registered checkouts, oldest registration first. */
  repositories() {
    return this.db
      .prepare("SELECT id,path FROM repositories ORDER BY rowid")
      .all()
      .map((row) => ({ id: String(row.id), path: String(row.path) }));
  }
  repositoryPath(id: string) {
    const row = this.db
      .prepare("SELECT path FROM repositories WHERE id=?")
      .get(id);

    if (!row) throw new SessionInputError("Repository is not registered.", 404);

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
      throw new SessionInputError(
        "Resource ID was already used for different content.",
        409,
      );

    return { id, kind, mimeType };
  }
  resource(id: string) {
    const row = this.db.prepare("SELECT * FROM resources WHERE id=?").get(id);

    if (!row) throw new SessionInputError("Resource not found.", 404);

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
    this.listeners.clear();
    this.catalogListeners.clear();
    this.activity.close();
    this.db.close();
  }
  /** The 404 check alone, without loading a snapshot. */
  assertExists(id: string) {
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id))
      throw new SessionInputError("Review not found.", 404);
  }
  read(id: string, version?: number): Snapshot {
    const row =
      version === undefined
        ? this.db
            .prepare(
              "SELECT snapshot FROM versions JOIN sessions ON sessions.id=session_id AND sessions.version=versions.version WHERE sessions.id=?",
            )
            .get(id)
        : this.db
            .prepare(
              "SELECT snapshot FROM versions WHERE session_id=? AND version=?",
            )
            .get(id, version);

    if (!row) throw new SessionInputError("Review or version not found.", 404);

    // SAFETY: versions contains only snapshots validated by execute before committing.
    const snapshot = JSON.parse(String(row.snapshot)) as Snapshot;

    // SAFETY: stored blocks were validated on write; migration only replaces
    // retired attachment representations with their canonical equivalent and
    // drops retired fields.
    // Lenses saved as document blocks read as the snapshot's own.
    const { document, lenses } = liftFileLenses(
      migrateStoredDocument(snapshot.document),
    );

    // SAFETY: stored blocks were validated on write; migration only replaces
    // retired representations and lifts retired lens blocks out.
    snapshot.document = document as Block[];

    if (lenses.length)
      snapshot.lenses = [...(snapshot.lenses ?? []), ...lenses];

    if (snapshot.pins)
      snapshot.target ??= {
        kind: "commits",
        repositoryId: snapshot.pins.repositoryId,
        base: snapshot.pins.base,
        head: snapshot.pins.head,
      };
    const live = version === undefined ? this.liveSources.get(id) : undefined;

    if (live?.version === snapshot.version) return structuredClone(live);

    return snapshot;
  }
  setDiffStats(
    pins: Pins,
    stats: NonNullable<SessionSummary["diffStats"]>,
    mode: "structural" | "textual" = "structural",
  ) {
    if (this.closing) return;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO comparison_stats(identity, stats) VALUES (?, ?)",
      )
      .run(JSON.stringify([pins, mode]), JSON.stringify(stats));

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
        `SELECT sessions.id FROM sessions JOIN versions ON versions.session_id=sessions.id AND versions.version=sessions.version WHERE json_extract(versions.snapshot,'$.origin.tutorial') = 1`,
      )
      .all()
      .map((row) => String(row.id));
  }

  list(mode: "structural" | "textual" = "structural"): SessionSummary[] {
    return this.summaries(mode);
  }
  /** One review's catalog entry, as review_list shows it. */
  summary(id: string): SessionSummary | undefined {
    return this.summaries("structural", id)[0];
  }
  private summaries(
    mode: "structural" | "textual",
    id?: string,
  ): SessionSummary[] {
    // One query, and the document never leaves SQLite: every catalog watcher
    // re-lists on every command.

    const reviews = this.db
      .prepare(
        `SELECT json_remove(versions.snapshot,'$.document') AS summary,
          (SELECT json_extract(first.snapshot,'$.createdAt') FROM versions AS first WHERE first.session_id=sessions.id ORDER BY first.version LIMIT 1) AS first_created_at,
          session_attention.viewed_at, session_attention.dismissed_at, repositories.name AS repository_name, repositories.path AS repository_path
        FROM sessions
        JOIN versions ON versions.session_id=sessions.id AND versions.version=sessions.version
        LEFT JOIN session_attention ON session_attention.session_id=sessions.id
        LEFT JOIN repositories ON repositories.id=json_extract(versions.snapshot,'$.pins.repositoryId')
        WHERE COALESCE(json_extract(versions.snapshot,'$.origin.tutorial'), 0) = 0
        ${id === undefined ? "" : "AND sessions.id=?"}
        ORDER BY sessions.rowid`,
      )
      .all(...(id === undefined ? [] : [id]))
      .map((row) => {
        // SAFETY: versions contains only snapshots validated by execute before committing.
        const summary = JSON.parse(String(row.summary)) as Omit<
          Snapshot,
          "document"
        >;

        if (summary.pins)
          summary.target ??= {
            kind: "commits",
            repositoryId: summary.pins.repositoryId,
            base: summary.pins.base,
            head: summary.pins.head,
          };

        const live = this.liveSources.get(summary.sessionId);

        if (
          live?.version === summary.version &&
          summary.target?.kind === "worktree"
        )
          summary.pins = live.pins;

        const listed: SessionSummary = {
          ...summary,
          firstCreatedAt: row.first_created_at
            ? String(row.first_created_at)
            : undefined,
          repositoryPath: row.repository_path
            ? String(row.repository_path)
            : undefined,
          repositoryGroup: row.repository_path
            ? this.repositoryGroup(String(row.repository_path))
            : undefined,
          repositoryName: row.repository_name
            ? String(row.repository_name)
            : (summary.pins?.repositoryId ?? ""),
          viewedAt: row.viewed_at ? String(row.viewed_at) : null,
          dismissedAt: row.dismissed_at ? String(row.dismissed_at) : null,
        };

        if (summary.kind === "scratchpad")
          listed.contents = this.scratchpadContents();

        return listed;
      });

    return this.withDiffStats(reviews, mode);
  }

  /** Local and imported summaries use the same persisted, mode-specific counts. */
  withDiffStats<T extends SessionSummary>(
    reviews: T[],
    mode: "structural" | "textual" = "structural",
  ): T[] {
    const stats = new Map(
      this.db
        .prepare("SELECT identity, stats FROM comparison_stats")
        .all()
        .map((row) => [
          String(row.identity),
          // SAFETY: comparison_stats is written only from the validated diff-stats contract.
          JSON.parse(String(row.stats)) as NonNullable<
            SessionSummary["diffStats"]
          >,
        ]),
    );

    return reviews.map((review) => ({
      ...review,
      diffStats: review.pins
        ? (stats.get(JSON.stringify([review.pins, mode])) ?? null)
        : null,
    }));
  }

  /** What the pad holds, for its Home card: blocks, and the diagrams among them. */
  private scratchpadContents(): NonNullable<SessionSummary["contents"]> {
    const blocks = elements(this.read(SCRATCHPAD_ID).document).filter(
      (element) => !isUnit(element),
    );

    return {
      blocks: blocks.length,
      diagrams: blocks.filter((block) => DIAGRAM_TYPES.has(block.type)).length,
    };
  }
  /** The one scratchpad, made on first use. The fixed command id makes a
   * repeat, even from another host on the same home, find its receipt. */
  async ensureScratchpad(): Promise<void> {
    if (this.has(SCRATCHPAD_ID)) return;

    try {
      await this.execute({
        commandId: SCRATCHPAD_COMMAND_ID,
        operation: {
          type: "create",
          title: SCRATCHPAD_TITLE,
          kind: "scratchpad",
        },
      });
    } catch (error) {
      if (!this.has(SCRATCHPAD_ID)) throw error;
    }
  }
  history(id: string) {
    return this.db
      .prepare(
        "SELECT version,json_extract(snapshot,'$.title') AS title,json_extract(snapshot,'$.createdAt') AS created_at FROM versions WHERE session_id=? ORDER BY version",
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
      throw new SessionInputError("Initial content requires a create command.");
    const request = JSON.stringify(initial ? { command, initial } : command);

    // Network and fetch time stay out of the write queue. A replayed command
    // never uses this: its receipt answers first, below.
    const pullRequest = this.startPullRequest(command);

    pullRequest?.catch(() => {});

    const run = this.pending.then(async () => {
      const receipt = this.db
        .prepare("SELECT request,response FROM receipts WHERE command_id=?")
        .get(command.commandId);

      if (receipt) {
        if (receipt.request === "null")
          throw new SessionInputError(
            "This command's review was deleted.",
            404,
          );

        if (
          !isDeepStrictEqual(
            JSON.parse(String(receipt.request)),
            JSON.parse(request),
          )
        )
          throw new SessionInputError(
            "Command ID was already used for different input.",
            409,
          );

        // SAFETY: receipts store only Results this method built, never caller-provided JSON.
        return JSON.parse(String(receipt.response)) as Result;
      }

      const op = command.operation;

      if (op.type !== "create" && op.type !== "attention") {
        this.activity.assertWrite(op.sessionId, command.leaseId, scopeOf(op));
      }

      // The scratchpad is edited and restored like a review, and nothing else.
      if (
        op.type !== "create" &&
        op.type !== "edit" &&
        op.type !== "lens" &&
        op.type !== "restore" &&
        this.read(op.sessionId).kind === "scratchpad"
      )
        throw new SessionInputError(
          "The scratchpad has no lifecycle, title or pins of its own.",
          409,
        );

      if (op.type === "create" && op.kind === "scratchpad") {
        if (op.pins || op.target)
          throw new SessionInputError(
            "A scratchpad has no target or pins of its own.",
          );

        if (this.has(SCRATCHPAD_ID))
          throw new SessionInputError("The scratchpad already exists.", 409);
      } else if (op.type === "create") {
        if (op.pins && op.target)
          throw new SessionInputError(
            "Supply exactly one of target or legacy pins.",
          );

        if (!op.pins && !op.target && !op.pullRequestUrl)
          throw new SessionInputError(
            "Supply a target, legacy pins, or a pullRequestUrl.",
          );

        if (op.repositoryId && (op.pins || op.target))
          throw new SessionInputError(
            "repositoryId applies only to a create from pullRequestUrl alone; put it in the target instead.",
          );

        if (!op.title && (op.pins || op.target))
          throw new SessionInputError("Supply a title.");
      }

      const requestedTarget =
        op.type === "create" || op.type === "set_target"
          ? op.target
          : undefined;

      const fromPullRequest = await pullRequest;

      const resolvedTarget = requestedTarget
        ? await this.providers.resolveTarget?.(requestedTarget)
        : fromPullRequest;

      if (requestedTarget && !resolvedTarget)
        throw new SessionInputError("Review targets are unavailable.");

      if (
        op.type === "create" &&
        op.pullRequestUrl &&
        op.reuseExisting !== false
      ) {
        const [found, ...others] = this.reviewsForPullRequest(
          op.pullRequestUrl,
        );

        if (found) {
          const result = this.existingReview(
            found,
            others,
            resolvedTarget?.pins ?? op.pins!,
            command.leaseId,
          );

          // Nothing is written but the receipt: a retry replays this answer,
          // and deleting the review erases it like any other command's.
          this.db
            .prepare(
              "INSERT INTO receipts(command_id,request,response) VALUES(?,?,?)",
            )
            .run(command.commandId, request, JSON.stringify(result));

          return result;
        }
      }

      if (op.type === "delete") {
        const result: Result = {
          sessionId: op.sessionId,
          version: this.read(op.sessionId).version,
          deleted: true,
        };

        this.commitCommand(
          command.commandId,
          request,
          result,
          () => {
            for (const table of [
              "authoring_sessions",
              "session_coverage",
              "session_attention",
              "versions",
            ])
              this.db
                .prepare(`DELETE FROM ${table} WHERE session_id=?`)
                .run(op.sessionId);
            this.db
              .prepare("DELETE FROM sessions WHERE id=?")
              .run(op.sessionId);
            // Keep command IDs so a delayed retry cannot recreate deleted content.
            // Erase their saved inputs while retaining the retry record.
            this.db
              .prepare(
                "UPDATE receipts SET request='null',response=? WHERE json_extract(response,'$.sessionId')=?",
              )
              .run(JSON.stringify(result), op.sessionId);
          },
          () =>
            this.assertMutation(op.sessionId, result.version, command.leaseId),
        );

        return result;
      }

      if (op.type === "attention") {
        const result: Result = {
          sessionId: op.sessionId,
          version: this.read(op.sessionId).version,
          attention: true,
        };

        this.commitCommand(command.commandId, request, result, () => {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO session_attention(session_id) VALUES(?)",
            )
            .run(op.sessionId);

          if (op.action === "view")
            this.db
              .prepare(
                "UPDATE session_attention SET viewed_at=? WHERE session_id=?",
              )
              .run(new Date().toISOString(), op.sessionId);
          else
            this.db
              .prepare(
                "UPDATE session_attention SET dismissed_at=? WHERE session_id=?",
              )
              .run(
                op.action === "dismiss" ? new Date().toISOString() : null,
                op.sessionId,
              );
        });

        return result;
      }

      const id =
        op.type !== "create"
          ? op.sessionId
          : op.kind === "scratchpad"
            ? SCRATCHPAD_ID
            : randomUUID();

      const previous = op.type === "create" ? undefined : this.read(id);

      let snapshot: Snapshot =
        op.type === "create"
          ? createdSnapshot(id, op, resolvedTarget, fromPullRequest?.title)
          : structuredClone(previous!);

      // Overlay state: a degraded read must not persist unavailability.
      delete snapshot.sourceUnavailable;
      // Each version describes only its own edit.
      delete snapshot.lastEdit;

      let nextId = previous
        ? Number(
            this.db.prepare("SELECT next_id FROM sessions WHERE id=?").get(id)!
              .next_id,
          )
        : 0;

      let applied: Applied | undefined;
      let lensTarget: { targetId: string; type: "lens" } | undefined;

      if (
        (op.type === "create" ||
          op.type === "set_target" ||
          op.type === "repin") &&
        this.providers.headBranch
      ) {
        const pins =
          resolvedTarget?.pins ??
          (op.type === "repin" ? op.pins : snapshot.pins);

        if (pins) {
          const headRef =
            requestedTarget?.kind === "commits"
              ? requestedTarget.head
              : undefined;

          const branch = await this.providers.headBranch(pins, headRef);

          snapshot.origin = { ...snapshot.origin, branch };
        }
      }

      switch (op.type) {
        case "create":
          if (initial) {
            snapshot.document = documentSchema.parse(initial.document);
            snapshot.origin = {
              ...snapshot.origin,
              ...structuredClone(initial.origin),
            };

            for (const block of snapshot.document)
              assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);
          }

          setPullRequest(snapshot, op.pullRequestUrl);
          break;
        case "rename":
          snapshot.title = op.title;
          break;
        case "set_target":
          if (snapshot.pins?.repositoryId !== resolvedTarget!.pins.repositoryId)
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
              snapshot.pins?.repositoryId !== op.pins.repositoryId
                ? null
                : undefined),
          );

          snapshot.staleSources = [];
          snapshot.pins = op.pins;
          snapshot.target = { kind: "commits", ...op.pins };
          break;
        case "restore":
          snapshot = this.read(id, op.version);
          delete snapshot.lastEdit;
          break;
        case "lens": {
          if (snapshot.kind === "scratchpad")
            throw new SessionInputError(
              "The scratchpad has no changes of its own to lens.",
              409,
            );

          const lenses = snapshot.lenses ?? [];
          const lens = applyLensEdit(lenses, op.edit, () => `lens-${++nextId}`);

          if (lenses.length) snapshot.lenses = lenses;
          else delete snapshot.lenses;
          lensTarget = { targetId: lens.id, type: "lens" };
          snapshot.lastEdit = {
            type: op.edit.type,
            targetId: lens.id,
            blockId: lens.id,
            kind: "lens",
            ...(op.edit.type === "update" && {
              fields: Object.keys(op.edit).filter(
                (key) => key !== "type" && key !== "targetId",
              ),
            }),
          };
          break;
        }

        case "edit": {
          applied = applyEdit(
            snapshot.document,
            op.edit,
            (prefix) => `${prefix}-${++nextId}`,
            // The scratchpad is a running log: the newest thought goes on top.
            { placement: snapshot.kind === "scratchpad" ? "first" : "last" },
          );

          snapshot.lastEdit = summarizeEdit(
            op.edit,
            applied,
            previous!.document,
            snapshot.document,
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
      }

      if (
        snapshot.target?.kind === "worktree" &&
        op.type !== "restore" &&
        !resolvedTarget
      ) {
        snapshot = await this.projectLiveSource(snapshot);
      }

      // Component shapes were checked at entry (or when merging a field patch).
      // Check cross-references here; do not reparse the whole stored document.
      checkReferences(snapshot.document);

      if (
        snapshot.pins &&
        (!previous ||
          JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins))
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
        ...(op.type === "create" && { created: true }),
        sessionId: id,
        version: snapshot.version,
        targetId: applied?.targetId ?? lensTarget?.targetId,
        ...(applied && { type: applied.type }),
        ...(lensTarget && { type: lensTarget.type }),
        ...(applied?.children && { children: applied.children }),
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
              "INSERT INTO sessions(id,version,next_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,next_id=excluded.next_id",
            )
            .run(id, snapshot.version, nextId);
          this.db
            .prepare(
              "INSERT INTO versions(session_id,version,snapshot) VALUES(?,?,?)",
            )
            .run(id, snapshot.version, JSON.stringify(snapshot));
        },
        previous
          ? () =>
              this.assertMutation(
                id,
                previous.version,
                command.leaseId,
                scopeOf(op),
              )
          : undefined,
        command.leaseId,
        scopeOf(op),
      );

      return result;
    });

    this.pending = run.catch(() => {});

    return run;
  }
  /** Resolve a target-less PR create before it queues, when it will need it. */
  private startPullRequest(
    command: z.infer<typeof commandSchema>,
  ): Promise<ResolvedPullRequest> | undefined {
    const op = command.operation;

    if (
      op.type !== "create" ||
      op.kind ||
      op.pins ||
      op.target ||
      !op.pullRequestUrl ||
      this.db
        .prepare("SELECT 1 FROM receipts WHERE command_id=?")
        .get(command.commandId)
    )
      return undefined;

    if (!this.providers.resolvePullRequest)
      return Promise.reject(
        new SessionInputError("Pull request targets are unavailable."),
      );

    // Keep an existing review's checkout so headMoved compares like with like.
    const [existing] =
      op.reuseExisting === false
        ? []
        : this.reviewsForPullRequest(op.pullRequestUrl);

    return this.providers.resolvePullRequest(op.pullRequestUrl, {
      id: op.repositoryId,
      preferred: existing && this.read(existing).pins?.repositoryId,
    });
  }
  /** Reviews whose PR is this one, newest version first. Summaries only. */
  private reviewsForPullRequest(url: string): string[] {
    return this.db
      .prepare(
        `SELECT sessions.id FROM sessions
        JOIN versions ON versions.session_id=sessions.id AND versions.version=sessions.version
        WHERE lower(json_extract(versions.snapshot,'$.origin.pullRequestUrl'))=?
          AND COALESCE(json_extract(versions.snapshot,'$.origin.tutorial'), 0) = 0
        ORDER BY json_extract(versions.snapshot,'$.createdAt') DESC, sessions.rowid DESC`,
      )
      .all(pullRequestKey(url))
      .map((row) => String(row.id));
  }
  /** The answer to a create that found its PR's review. Its target stays:
   * moving it would silently point existing links at different code. */
  private existingReview(
    sessionId: string,
    others: string[],
    requested: Pins,
    leaseId?: string,
  ): Result {
    const snapshot = this.read(sessionId);

    const headMoved =
      snapshot.pins?.repositoryId !== requested.repositoryId ||
      snapshot.pins?.head !== requested.head;

    const ownedBy = this.activity.heldByAnother(sessionId, leaseId);

    const note = [
      "Returned the existing review for this PR instead of creating one; the requested title and target were not applied. Update it in place (read it with session_get first), or pass reuseExisting:false to create a separate review.",
      headMoved &&
        "The PR head moved since this review's target was set, and the target was NOT changed: call review_set_target to move it, then repair the source references it reports.",
      ownedBy &&
        "Another session is authoring it now; wait for its lease to end before editing.",
      others.length > 0 &&
        "Older sessions also name this PR; see otherReviewIds.",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      created: false,
      note,
      sessionId,
      version: snapshot.version,
      target: snapshot.target,
      headMoved,
      ...(ownedBy && { ownedBy: "another session" as const }),
      ...(others.length > 0 && { otherReviewIds: others }),
    };
  }
  private commitCommand(
    commandId: string,
    request: string,
    result: Result,
    apply: () => void,
    guard?: () => void,
    leaseId?: string,
    scope: LeaseScope = "document",
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    let extended = false;

    try {
      guard?.();
      apply();
      this.db
        .prepare(
          "INSERT INTO receipts(command_id,request,response) VALUES(?,?,?)",
        )
        .run(commandId, request, JSON.stringify(result));
      // An accepted write is proof of life: it renews the author's lease.
      extended = this.activity.extend(result.sessionId, leaseId, scope);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (result.deleted) this.activity.deleted(result.sessionId);
    else if (extended) this.activity.extended(result.sessionId);
    this.notify(result);
  }
  private assertMutation(
    sessionId: string,
    version: number | undefined,
    leaseId?: string,
    scope: LeaseScope = "document",
  ) {
    this.activity.assertWrite(sessionId, leaseId, scope);

    const current = this.db
      .prepare("SELECT version FROM sessions WHERE id=?")
      .get(sessionId);

    if ((current ? Number(current.version) : undefined) !== version)
      throw new SessionInputError(
        "Review changed during validation. Reread it and retry the edit.",
        409,
      );
  }

  private notify(result: Result) {
    if (result.deleted) this.observedVersions.delete(result.sessionId);
    else if (!result.attention)
      this.observedVersions.set(result.sessionId, result.version);

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
  has(sessionId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId) !==
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

    const sessionId =
      inputs[0]?.sessionId ?? options.preserveCurrent?.sessionId;

    if (!sessionId) return Promise.reject(new Error("Nothing to import."));

    if (
      inputs.some((input) => input.sessionId !== sessionId) ||
      (options.preserveCurrent &&
        options.preserveCurrent.sessionId !== sessionId)
    )
      return Promise.reject(new Error("Import versions of one review only."));

    const run = this.pending.then(async () => {
      this.activity.assertWrite(sessionId);

      const existing = this.db
        .prepare("SELECT version,next_id FROM sessions WHERE id=?")
        .get(sessionId);

      let nextId = existing ? Number(existing.next_id) : 0;
      let version = existing ? Number(existing.version) : -1;
      const snapshots: Snapshot[] = [];
      const warnings: string[] = [];

      for (const input of inputs) {
        const document = structuredClone(
          documentSchema.parse(migrateStoredDocument(input.document)),
        );

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
            ? await this.providers.validateSourceTolerant(
                anchorPins(source, input.pins),
                source,
                { peek: peek === true },
              )
            : null;

          if (warning) warnings.push(warning);
        }

        for (const block of resourceReferences(document))
          await this.providers.validateResource(input.pins, block);

        version += 1;

        const snapshot: Snapshot = {
          sessionId,
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
          throw new SessionInputError("Review changed during migration.", 409);

        const document = documentSchema.parse(
          migrateStoredDocument(options.preserveCurrent.document),
        );

        snapshots.push({
          ...options.preserveCurrent,
          document,
          version: ++version,
        });
      }

      const attention = inputs[0]?.attention;
      this.db.exec("BEGIN IMMEDIATE");

      try {
        this.assertMutation(
          sessionId,
          existing ? Number(existing.version) : undefined,
        );
        this.db
          .prepare(
            "INSERT INTO sessions(id,version,next_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,next_id=excluded.next_id",
          )
          .run(sessionId, version, nextId);

        for (const snapshot of snapshots)
          this.db
            .prepare(
              "INSERT INTO versions(session_id,version,snapshot) VALUES(?,?,?)",
            )
            .run(sessionId, snapshot.version, JSON.stringify(snapshot));

        if (!existing && attention)
          this.db
            .prepare(
              "INSERT INTO session_attention(session_id,viewed_at,dismissed_at) VALUES(?,?,?)",
            )
            .run(
              sessionId,
              attention.viewedAt ?? null,
              attention.dismissedAt ?? null,
            );

        const cursor = options.revision ?? inputs.at(-1)?.origin?.revision;

        // The importer records the map once it knows whether it landed.
        if (cursor)
          this.recordLegacyImport(sessionId, {
            revision: cursor,
            mapRevision: null,
          });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      this.notify({ sessionId, version });

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

    const references = (
      document: Block[],
      tolerant = false,
      lenses: readonly Lens[] = [],
    ) => {
      const sources = new Map<
        string,
        { source: FileLineRange; peek: boolean }
      >();

      const resources = new Map<string, Block>();

      const add = (source: FileLineRange, peek: boolean) => {
        const key = JSON.stringify(source);
        const kept = sources.get(key);
        sources.set(key, { source, peek: peek || (kept?.peek ?? false) });
      };

      for (const { source, peek } of sourceReferences(document, { tolerant }))
        add(source, peek === true);

      // A lens range is a prose-like link: it must exist, not read as a peek.
      for (const { source } of lensSelections(lenses))
        for (const anchor of sourceAnchors(source)) add(anchor, false);

      for (const block of resourceReferences(document))
        resources.set(JSON.stringify(block), block);

      return { sources, resources };
    };

    const current = references(snapshot.document, repin, snapshot.lenses);

    // Stored content is not re-validated: an edit may fix a link that the
    // current rules reject.
    const pinsChanged =
      previous &&
      JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins);

    const worktreeMoved = pinsChanged && snapshot.target?.kind === "worktree";

    const retained = references(
      previous?.document ?? [],
      true,
      previous?.lenses,
    );

    // Independent reads of immutable commits: run them concurrently.
    const checks: Promise<void>[] = [];

    // Pins a reference names itself must be resolved commits of a registered
    // repository, like document pins. Check each distinct new set once.
    const retainedPins = new Set(
      explicitPins([...retained.sources.values()]).map((pins) =>
        JSON.stringify(pins),
      ),
    );

    for (const pins of explicitPins([...current.sources.values()]))
      if (!retainedPins.has(JSON.stringify(pins)))
        checks.push(this.providers.validatePins(pins));

    for (const [key, { source, peek }] of current.sources) {
      const kept = retained.sources.get(key);

      // A range validated earlier as a prose link still needs the peek check
      // the first time a code peek points at it. A reference with its own
      // pins is unaffected by the document's pins changing.
      if ((pinsChanged && !source.pins) || !kept || (peek && !kept.peek))
        checks.push(
          this.providers
            .validateSource(anchorPins(source, snapshot.pins), source, {
              peek,
            })
            .then(
              () => {
                if (repin)
                  warnings.push(
                    `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: source pins changed; verify that this range still supports the document.`,
                  );
              },
              (error) => {
                if (
                  (!repin && !(worktreeMoved && kept)) ||
                  !(error instanceof SessionInputError)
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
                !(error instanceof SessionInputError)
              )
                throw error;
              warnings.push(`${block.id} (${block.type}): ${error.message}`);
            }),
        );

    await Promise.all(checks);

    return warnings.sort();
  }
}

/** Lens writes need the lenses lease; every other write needs the document's. */
function scopeOf(operation: { type: string }): LeaseScope {
  return operation.type === "lens" ? "lenses" : "document";
}

/** A new document's first version, before its initial content. Field order
 * is kept so stored JSON reads as it always has. */
function createdSnapshot(
  id: string,
  op: {
    title?: string;
    kind?: "scratchpad";
    pins?: z.infer<typeof pinsSchema>;
  },
  resolved: { target: SessionTarget; pins: Pins } | undefined,
  defaultTitle?: string,
): Snapshot {
  const pins = resolved?.pins ?? op.pins;
  const title = op.title ?? defaultTitle;

  if (!title) throw new SessionInputError("Supply a title.");

  if (!pins)
    return {
      sessionId: id,
      version: 0,
      title,
      kind: op.kind,
      document: [],
      createdAt: "",
    };

  return {
    sessionId: id,
    version: 0,
    title,
    pins,
    target: resolved?.target ?? { kind: "commits", ...pins },
    document: [],
    createdAt: "",
  };
}

export function inspectSnapshot(snapshot: Snapshot, targetId?: string) {
  if (targetId !== undefined) {
    const target = elements(snapshot.document).find(
      (element) => element.id === targetId,
    );

    if (!target)
      throw new SessionInputError("Target not found in this version.", 404);

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
