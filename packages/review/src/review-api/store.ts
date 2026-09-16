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
  type Source,
  applyEdit,
  assignFreshIds,
  checkReferences,
  documentSchema,
  editSchema,
  elements,
  pinsSchema,
  resourceReferences,
  sourceReferences,
} from "./document.js";

const reviewId = z.string().min(1);

export const commandSchema = z.strictObject({
  commandId: z.uuid(),
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
      pins: pinsSchema,
    }),
    z.strictObject({ type: z.literal("edit"), reviewId, edit: editSchema }),
    z.strictObject({
      type: z.literal("rename"),
      reviewId,
      title: z.string().trim().min(1),
    }),
    z.strictObject({ type: z.literal("repin"), reviewId, pins: pinsSchema }),
    z.strictObject({
      type: z.literal("restore"),
      reviewId,
      version: z.number().int().nonnegative(),
    }),
  ]),
});

/** Where a review came from, for Home cards. Set by legacy import; the
 * authoring API leaves it absent. */
export interface SnapshotOrigin {
  branch?: string;
  baseRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  /** The legacy review revision this version was imported from. */
  revision?: string;
}

export interface Snapshot {
  reviewId: string;
  version: number;
  title: string;
  pins: Pins;
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
}

export interface ReviewProviders {
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
  readonly activity = new ReviewActivity();
  private readonly db: DatabaseSync;
  private pending: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly listeners = new Set<(result: Result) => void>();
  private readonly catalogListeners = new Set<() => void>();
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
      `CREATE TABLE IF NOT EXISTS legacy_imports(review_id TEXT PRIMARY KEY, revision TEXT NOT NULL, imported_at TEXT NOT NULL);`,
    );
  }
  /** The last legacy revision imported for a review, kept after deletion. */
  legacyImport(
    reviewId: string,
  ): { revision: string; importedAt: string } | null {
    const row = this.db
      .prepare(
        "SELECT revision,imported_at FROM legacy_imports WHERE review_id=?",
      )
      .get(reviewId);

    return row
      ? { revision: String(row.revision), importedAt: String(row.imported_at) }
      : null;
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
    await this.pending;
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
    return JSON.parse(String(row.snapshot)) as Snapshot;
  }
  list(): ReviewApiSummary[] {
    // One query, and the document never leaves SQLite: every catalog watcher
    // re-lists on every command.
    return this.db
      .prepare(
        `SELECT json_remove(versions.snapshot,'$.document') AS summary,
          review_attention.viewed_at, review_attention.dismissed_at, repositories.name AS repository_name
        FROM reviews
        JOIN versions ON versions.review_id=reviews.id AND versions.version=reviews.version
        LEFT JOIN review_attention ON review_attention.review_id=reviews.id
        LEFT JOIN repositories ON repositories.id=json_extract(versions.snapshot,'$.pins.repositoryId')
        ORDER BY reviews.rowid`,
      )
      .all()
      .map((row) => {
        // SAFETY: versions contains only snapshots validated by execute before committing.
        const summary = JSON.parse(String(row.summary)) as Omit<
          Snapshot,
          "document"
        >;

        return {
          ...summary,
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Command boundary: commandSchema.parse below rejects malformed input before mutation.
  execute(input: unknown): Promise<Result> {
    if (this.closing)
      return Promise.reject(new Error("Review store is closing."));
    const command = commandSchema.parse(input);
    const request = JSON.stringify(command);

    const run = this.pending.then(async () => {
      const receipt = this.db
        .prepare("SELECT request,response FROM receipts WHERE command_id=?")
        .get(command.commandId);

      if (receipt) {
        if (receipt.request === "null")
          throw new ReviewInputError("This command's review was deleted.", 404);

        if (!isDeepStrictEqual(JSON.parse(String(receipt.request)), command))
          throw new ReviewInputError(
            "Command ID was already used for different input.",
            409,
          );

        // SAFETY: receipts stores the Result created in commitCommand, never caller-provided JSON.
        return JSON.parse(String(receipt.response)) as Result;
      }

      const op = command.operation;

      if (op.type === "delete") {
        const result: Result = {
          reviewId: op.reviewId,
          version: this.read(op.reviewId).version,
          deleted: true,
        };

        this.commitCommand(command.commandId, request, result, () => {
          for (const table of ["review_attention", "versions"])
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
        });

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
              pins: op.pins,
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
          break;
        case "rename":
          snapshot.title = op.title;
          break;
        case "repin":
          snapshot.pins = op.pins;
          snapshot.document = [];
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
          break;
      }

      // Component shapes were checked at entry (or when merging a field patch).
      // Check cross-references here; do not reparse the whole stored document.
      checkReferences(snapshot.document);

      if (
        !previous ||
        JSON.stringify(previous.pins) !== JSON.stringify(snapshot.pins)
      )
        await this.providers.validatePins(snapshot.pins);
      await this.validateExternal(snapshot, previous);
      snapshot.version = previous ? previous.version + 1 : 0;
      snapshot.createdAt = new Date().toISOString();

      const result: Result = {
        reviewId: id,
        version: snapshot.version,
        targetId,
      };

      this.commitCommand(command.commandId, request, result, () => {
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
      });

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
  ) {
    this.db.exec("BEGIN IMMEDIATE");

    try {
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

    if (result.deleted) this.activity.remove(result.reviewId);
    this.notify(result);
  }

  private notify(result: Result) {
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
  ): Promise<{ version: number; warnings: string[] }> {
    if (this.closing)
      return Promise.reject(new Error("Review store is closing."));

    if (inputs.length === 0)
      return Promise.reject(new Error("Nothing to import."));

    const reviewId = inputs[0]!.reviewId;

    if (inputs.some((input) => input.reviewId !== reviewId))
      return Promise.reject(new Error("Import versions of one review only."));

    const run = this.pending.then(async () => {
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
          document,
          createdAt: input.createdAt,
        };

        if (input.origin) snapshot.origin = input.origin;
        snapshots.push(snapshot);
      }

      const attention = inputs[0]!.attention;
      this.db.exec("BEGIN IMMEDIATE");

      try {
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

        const cursor = inputs.at(-1)?.origin?.revision;

        if (cursor)
          this.db
            .prepare(
              "INSERT INTO legacy_imports(review_id,revision,imported_at) VALUES(?,?,?) ON CONFLICT(review_id) DO UPDATE SET revision=excluded.revision,imported_at=excluded.imported_at",
            )
            .run(reviewId, cursor, new Date().toISOString());
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
  private async validateExternal(snapshot: Snapshot, previous?: Snapshot) {
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

    const current = references(snapshot.document);

    // Stored content is not re-validated: an edit may fix a link that the
    // current rules reject.
    const retained = references(
      previous &&
        JSON.stringify(previous.pins) === JSON.stringify(snapshot.pins)
        ? previous.document
        : [],
      true,
    );

    // Independent reads of immutable commits: run them concurrently.
    const checks: Promise<void>[] = [];

    for (const [key, { source, peek }] of current.sources) {
      const kept = retained.sources.get(key);

      // A range validated earlier as a prose link still needs the peek check
      // the first time a code peek points at it.
      if (!kept || (peek && !kept.peek))
        checks.push(
          this.providers.validateSource(snapshot.pins, source, { peek }),
        );
    }

    for (const [key, block] of current.resources)
      if (!retained.resources.has(key))
        checks.push(this.providers.validateResource(snapshot.pins, block));

    await Promise.all(checks);
  }
}
