import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { processIsAlive } from "@dev.fast/trace-core";
import { z } from "zod";

import {
  ReviewInputError,
  applyEdit,
  assignFreshIds,
  checkReferences,
  documentSchema,
  editSchema,
  elements,
  pinsSchema,
} from "./document.js";
import { pullRequestUrl, setPullRequest } from "./origin.js";
import type { Result, Snapshot, SnapshotOrigin } from "./store.js";

export type AuthoringMode = "interactive" | "batch";

const draftId = z.uuid();

const metadata = {
  title: z.string().trim().min(1).optional(),
  pins: pinsSchema.optional(),
  pullRequestUrl: pullRequestUrl.nullable().optional(),
};

export const draftCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("begin"),
    reviewId: z.string().min(1).optional(),
    ...metadata,
  }),
  z.strictObject({
    type: z.literal("write"),
    draftId,
    document: documentSchema,
    ...metadata,
  }),
  z.strictObject({ type: z.literal("edit"), draftId, edit: editSchema }),
  z.strictObject({ type: z.literal("validate"), draftId }),
  z.strictObject({ type: z.literal("commit"), draftId, commandId: z.uuid() }),
  z.strictObject({ type: z.literal("abort"), draftId }),
]);

export interface Draft {
  draftId: string;
  reviewId: string;
  baseVersion: number | null;
  revision: number;
  title: string;
  pins: z.infer<typeof pinsSchema>;
  document: z.infer<typeof documentSchema>;
  origin?: SnapshotOrigin;
}

interface WorkingDraft extends Draft {
  nextId: number;
}

interface DraftHost {
  read(reviewId: string): Snapshot;
  assertInteractiveUnlocked(reviewId: string): void;
  validate(snapshot: Snapshot): Promise<void>;
  notify(result: Result): void;
}

/** Scratch state is owned by one server instance, never by a model heartbeat. */
export class ReviewDrafts {
  private readonly ownerId = randomUUID();

  constructor(
    private readonly db: DatabaseSync,
    private readonly host: DraftHost,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS authoring_drafts(
      review_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, draft TEXT NOT NULL
    )`);
    this.transaction(() => {
      for (const row of db
        .prepare("SELECT review_id FROM authoring_drafts")
        .all())
        this.discardOrphan(String(row.review_id));
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const result = operation();
      this.db.exec("COMMIT");

      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private discardOrphan(reviewId: string) {
    const row = this.db
      .prepare(
        "SELECT draft_id,owner_pid FROM authoring_drafts WHERE review_id=?",
      )
      .get(reviewId);

    if (row && !processIsAlive(Number(row.owner_pid)))
      this.db
        .prepare("DELETE FROM authoring_drafts WHERE draft_id=?")
        .run(row.draft_id);
  }

  /** Called at every interactive/import mutation boundary, including commit. */
  assertUnlocked(reviewId: string) {
    this.discardOrphan(reviewId);

    if (
      this.db
        .prepare("SELECT 1 FROM authoring_drafts WHERE review_id=?")
        .get(reviewId)
    )
      throw new ReviewInputError(
        "This review is owned by a batch draft. Commit or abort it, or stop its authoring server, before editing elsewhere.",
        409,
      );
  }

  private owned(id: string): WorkingDraft {
    const row = this.db
      .prepare("SELECT owner_id,draft FROM authoring_drafts WHERE draft_id=?")
      .get(id);

    if (!row)
      throw new ReviewInputError(
        "Draft not found; it was committed, aborted or discarded after its server stopped.",
        404,
      );

    if (row.owner_id !== this.ownerId)
      throw new ReviewInputError(
        "This draft belongs to another running server. Use that server or stop it before starting again.",
        409,
      );

    // SAFETY: only this module writes this internal, schema-checked draft representation.
    return JSON.parse(String(row.draft)) as WorkingDraft;
  }

  read(id: string): Draft {
    const { nextId: _counter, ...draft } = this.owned(id);

    return draft;
  }

  source(id: string): Snapshot {
    return this.snapshot(this.owned(id));
  }

  private snapshot(draft: Draft): Snapshot {
    return {
      reviewId: draft.reviewId,
      version: (draft.baseVersion ?? -1) + 1,
      title: draft.title,
      pins: draft.pins,
      target: { kind: "commits", ...draft.pins },
      document: structuredClone(draft.document),
      origin: draft.origin,
      createdAt: new Date().toISOString(),
    };
  }

  private metadata(
    draft: WorkingDraft,
    input: z.infer<typeof draftCommandSchema> & { type: "begin" | "write" },
  ) {
    if (input.title !== undefined) draft.title = input.title;

    if (input.pins) {
      if (
        input.pins.repositoryId !== draft.pins.repositoryId &&
        input.pullRequestUrl === undefined
      )
        setPullRequest(draft, null);
      draft.pins = input.pins;
    }

    setPullRequest(draft, input.pullRequestUrl);
  }

  private save(draft: WorkingDraft) {
    this.db
      .prepare(
        "UPDATE authoring_drafts SET draft=? WHERE draft_id=? AND owner_id=?",
      )
      .run(JSON.stringify(draft), draft.draftId, this.ownerId);
    // Reserve returned IDs even if an update draft is later aborted.
    this.db
      .prepare("UPDATE reviews SET next_id=MAX(next_id,?) WHERE id=?")
      .run(draft.nextId, draft.reviewId);
  }

  async execute(input: z.infer<typeof draftCommandSchema>) {
    if (input.type === "begin") {
      return this.transaction(() => {
        const reviewId = input.reviewId ?? randomUUID();
        this.assertUnlocked(reviewId);
        this.host.assertInteractiveUnlocked(reviewId);
        const id = randomUUID();
        // Claim under the write transaction before reading the starting version.
        this.db
          .prepare("INSERT INTO authoring_drafts VALUES(?,?,?,?,?)")
          .run(reviewId, id, this.ownerId, process.pid, "{}");
        const previous = input.reviewId ? this.host.read(reviewId) : undefined;

        if (previous?.target.kind === "worktree" && !input.pins)
          throw new ReviewInputError(
            "Batch authoring requires fixed commits. Supply resolved base/head pins to replace this live worktree target.",
          );
        const pins = input.pins ?? previous?.pins;
        const title = input.title ?? previous?.title;

        if (!pins || !title)
          throw new ReviewInputError(
            "A new draft requires title and resolved pins.",
          );

        const draft: WorkingDraft = {
          draftId: id,
          reviewId,
          baseVersion: previous?.version ?? null,
          revision: 0,
          title,
          pins: previous?.pins ?? pins,
          document: previous?.document ?? [],
          origin: previous?.origin,
          nextId: previous
            ? Number(
                this.db
                  .prepare("SELECT next_id FROM reviews WHERE id=?")
                  .get(reviewId)!.next_id,
              )
            : 0,
        };

        this.metadata(draft, input);
        this.save(draft);

        return this.read(id);
      });
    }

    if (input.type === "commit") {
      const receipt = this.db
        .prepare("SELECT request,response FROM receipts WHERE command_id=?")
        .get(input.commandId);

      if (receipt) {
        if (receipt.request === "null")
          throw new ReviewInputError("This command's review was deleted.", 404);

        if (
          !isDeepStrictEqual(JSON.parse(String(receipt.request)), {
            draftCommand: input,
          })
        )
          throw new ReviewInputError(
            "Command ID was already used for different input.",
            409,
          );

        // SAFETY: the saved receipt is the committed Result, not caller JSON.
        return JSON.parse(String(receipt.response)) as Result;
      }
    }

    const draft = this.owned(input.draftId);

    if (input.type === "abort") {
      this.transaction(() => {
        this.owned(input.draftId);
        this.db
          .prepare(
            "DELETE FROM authoring_drafts WHERE draft_id=? AND owner_id=?",
          )
          .run(input.draftId, this.ownerId);
      });

      return { draftId: input.draftId, aborted: true };
    }

    if (input.type === "write" || input.type === "edit") {
      return this.transaction(() => {
        this.owned(input.draftId);

        if (input.type === "write") {
          draft.document = structuredClone(input.document);

          for (const block of draft.document)
            assignFreshIds(block, (prefix) => `${prefix}-${++draft.nextId}`);
          this.metadata(draft, input);
        } else {
          applyEdit(
            draft.document,
            input.edit,
            (prefix) => `${prefix}-${++draft.nextId}`,
          );
        }

        draft.revision++;
        this.save(draft);

        return this.read(input.draftId);
      });
    }

    const snapshot = this.snapshot(draft);
    documentSchema.parse(snapshot.document);
    checkReferences(snapshot.document);
    await this.host.validate(snapshot);

    if (input.type === "validate") {
      this.owned(input.draftId);

      return { draftId: input.draftId, valid: true };
    }

    for (const block of elements(snapshot.document))
      if (block.type === "section") block.status = "complete";

    const result: Result = {
      reviewId: draft.reviewId,
      version: snapshot.version,
    };

    this.transaction(() => {
      const owned = this.owned(input.draftId);

      const current = this.db
        .prepare("SELECT version FROM reviews WHERE id=?")
        .get(draft.reviewId);

      if (
        owned.revision !== draft.revision ||
        (current ? Number(current.version) : null) !== draft.baseVersion
      )
        throw new ReviewInputError(
          "The draft's starting version changed. Abort it and begin a fresh draft.",
          409,
        );
      this.host.assertInteractiveUnlocked(draft.reviewId);
      this.db
        .prepare(
          "INSERT INTO reviews VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,next_id=MAX(reviews.next_id,excluded.next_id)",
        )
        .run(draft.reviewId, snapshot.version, draft.nextId);
      this.db
        .prepare("INSERT INTO versions VALUES(?,?,?)")
        .run(draft.reviewId, snapshot.version, JSON.stringify(snapshot));
      this.db
        .prepare("INSERT INTO receipts VALUES(?,?,?)")
        .run(
          input.commandId,
          JSON.stringify({ draftCommand: input }),
          JSON.stringify(result),
        );
      this.db
        .prepare("DELETE FROM authoring_drafts WHERE draft_id=? AND owner_id=?")
        .run(input.draftId, this.ownerId);
    });
    this.host.notify(result);

    return result;
  }

  close() {
    this.db
      .prepare("DELETE FROM authoring_drafts WHERE owner_id=?")
      .run(this.ownerId);
  }
}
