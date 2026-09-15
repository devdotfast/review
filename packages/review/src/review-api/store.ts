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
  checkReferences,
  editSchema,
  elements,
  pinsSchema,
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

export interface Snapshot {
  reviewId: string;
  version: number;
  title: string;
  pins: Pins;
  document: Block[];
  createdAt: string;
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
  validateSource(pins: Pins, source: Source): Promise<void>;
  validateResource(pins: Pins, block: Block): Promise<void>;
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
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA foreign_keys=ON;
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
    return this.db
      .prepare("SELECT id FROM reviews ORDER BY rowid")
      .all()
      .map((row) => {
        const { document: _, ...summary } = this.read(String(row.id));

        const attention = this.db
          .prepare(
            "SELECT viewed_at,dismissed_at FROM review_attention WHERE review_id=?",
          )
          .get(summary.reviewId);

        const repository = this.db
          .prepare("SELECT name FROM repositories WHERE id=?")
          .get(summary.pins.repositoryId);

        return {
          ...summary,
          repositoryName: repository
            ? String(repository.name)
            : summary.pins.repositoryId,
          viewedAt: attention?.viewed_at ? String(attention.viewed_at) : null,
          dismissedAt: attention?.dismissed_at
            ? String(attention.dismissed_at)
            : null,
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

    if (!result.attention)
      for (const listener of this.listeners) listener(result);

    for (const listener of this.catalogListeners) listener();
  }
  private async validateExternal(snapshot: Snapshot, previous?: Snapshot) {
    const references = (document: Block[]) => {
      const sources = new Map<string, Source>();
      const resources = new Map<string, Block>();

      const add = (source: Source) =>
        sources.set(JSON.stringify(source), source);

      for (const { source } of sourceReferences(document)) add(source);

      for (const block of elements(document)) {
        if (
          block.type === "image" ||
          block.type === "trace_quote" ||
          block.type === "software_map"
        )
          resources.set(JSON.stringify(block), block);
      }

      return { sources, resources };
    };

    const current = references(snapshot.document);

    const retained = references(
      previous &&
        JSON.stringify(previous.pins) === JSON.stringify(snapshot.pins)
        ? previous.document
        : [],
    );

    for (const [key, source] of current.sources)
      if (!retained.sources.has(key))
        await this.providers.validateSource(snapshot.pins, source);

    for (const [key, block] of current.resources)
      if (!retained.resources.has(key))
        await this.providers.validateResource(snapshot.pins, block);
  }
}
