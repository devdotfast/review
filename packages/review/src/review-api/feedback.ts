import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  type FeedbackMessage,
  type FeedbackSnapshot,
  type FeedbackSubmission,
  type FeedbackThread,
  type ThreadTarget,
  ThreadTargetSchema,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { ReviewInputError } from "./document.js";
import type { Snapshot } from "./store.js";

const id = z.string().min(1);

const body = z.string().trim().min(1);

const version = z.number().int().nonnegative();

export const feedbackActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("save"),
    threadId: id,
    messageId: id,
    version,
    target: ThreadTargetSchema.optional(),
    body,
  }),
  z.strictObject({
    type: z.literal("post"),
    threadId: id,
    messageId: id,
    version,
    target: ThreadTargetSchema.optional(),
    body,
  }),
  z.strictObject({
    type: z.literal("reply"),
    threadId: id,
    messageId: id,
    version,
    body,
    by: z.enum(["user", "agent"]),
  }),
  z.strictObject({
    type: z.literal("edit-draft"),
    threadId: id,
    messageId: id,
    body,
  }),
  z.strictObject({
    type: z.literal("discard-draft"),
    threadId: id,
    messageId: id.optional(),
  }),
  z.strictObject({
    type: z.literal("resolve"),
    threadId: id,
    resolved: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("submit"),
    version,
    decision: z.enum(["approve", "request-changes"]),
    messageIds: z.array(id),
  }),
]);

export type {
  FeedbackMessage,
  FeedbackThread,
  FeedbackSubmission,
  FeedbackSnapshot,
} from "@dev.fast/review-protocol";

/** Shares the host database and command transaction; no cached thread projection. */
export class ReviewFeedback {
  private readonly listeners = new Set<(reviewId: string) => void>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly document: (reviewId: string, version?: number) => Snapshot,
    private readonly validateTarget: (
      snapshot: Snapshot,
      target: ThreadTarget,
    ) => Promise<void>,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS feedback_threads(review_id TEXT NOT NULL REFERENCES reviews(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(review_id,id));
      CREATE TABLE IF NOT EXISTS feedback_submissions(review_id TEXT NOT NULL REFERENCES reviews(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(review_id,id));`);
  }
  read(reviewId: string): FeedbackSnapshot {
    if (!this.db.prepare("SELECT 1 FROM reviews WHERE id=?").get(reviewId))
      throw new ReviewInputError("Review not found.", 404);

    return {
      // The command receipt row is an ordering token, not a write precondition.
      revision: Number(
        this.db
          .prepare("SELECT COALESCE(MAX(rowid),0) AS revision FROM receipts")
          .get()!.revision,
      ),
      threads: this.db
        .prepare(
          "SELECT data FROM feedback_threads WHERE review_id=? ORDER BY rowid",
        )
        .all(reviewId)
        .map((row) => JSON.parse(String(row.data))),
      submissions: this.db
        .prepare(
          "SELECT data FROM feedback_submissions WHERE review_id=? ORDER BY rowid",
        )
        .all(reviewId)
        .map((row) => JSON.parse(String(row.data))),
    };
  }
  subscribe(listener: (reviewId: string) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  changed(reviewId: string) {
    for (const listener of this.listeners) listener(reviewId);
  }
  close() {
    this.listeners.clear();
  }

  /** Called inside the host's write queue; apply runs in its SQLite transaction. */
  async prepare(
    reviewId: string,
    action: z.infer<typeof feedbackActionSchema>,
  ) {
    const current = this.read(reviewId);
    const now = new Date().toISOString();

    const snapshot =
      "version" in action ? this.document(reviewId, action.version) : undefined;

    const threadId = "threadId" in action ? action.threadId : undefined;
    let thread = current.threads.find((thread) => thread.id === threadId);
    const touched = new Set<FeedbackThread>();
    let submission: FeedbackSubmission | undefined;

    switch (action.type) {
      case "save":
      case "post":
      case "reply": {
        if (!thread) {
          if (action.type === "reply")
            throw new ReviewInputError("Thread not found.", 404);

          if (!action.target)
            throw new ReviewInputError("New threads need a comment target.");
          await this.validateTarget(snapshot!, action.target);
          thread = {
            id: action.threadId,
            version: action.version,
            target: action.target,
            resolved: false,
            messages: [],
          };
        }

        if (
          current.threads.some((item) =>
            item.messages.some((message) => message.id === action.messageId),
          )
        )
          throw new ReviewInputError(
            "Message ID already exists; retry the original command or send a new message.",
            409,
          );
        thread.messages.push({
          id: action.messageId,
          version: action.version,
          body: action.body,
          by: action.type === "reply" ? action.by : "user",
          draft: action.type === "save",
          createdAt: now,
        });
        thread.resolved = false;
        touched.add(thread);
        break;
      }

      case "edit-draft": {
        const message = thread?.messages.find(
          (message) => message.id === action.messageId,
        );

        if (!message) throw new ReviewInputError("Draft not found.", 404);

        if (!message.draft)
          throw new ReviewInputError(
            "Posted messages cannot be edited. Send a follow-up instead.",
            409,
          );
        message.body = action.body;
        touched.add(thread!);
        break;
      }

      case "discard-draft": {
        if (!thread) throw new ReviewInputError("Thread not found.", 404);

        if (action.messageId) {
          const message = thread.messages.find(
            (message) => message.id === action.messageId,
          );

          if (!message) throw new ReviewInputError("Draft not found.", 404);

          if (!message.draft)
            throw new ReviewInputError(
              "Posted messages cannot be deleted.",
              409,
            );
        }

        thread.messages = thread.messages.filter(
          (message) =>
            !message.draft ||
            (action.messageId !== undefined && message.id !== action.messageId),
        );
        touched.add(thread);
        break;
      }

      case "resolve":
        if (!thread) throw new ReviewInputError("Thread not found.", 404);
        thread.resolved = action.resolved;
        touched.add(thread);
        break;
      case "submit": {
        const pending = new Set(action.messageIds);

        for (const item of current.threads) {
          for (const message of item.messages) {
            if (!pending.delete(message.id)) continue;

            if (!message.draft)
              throw new ReviewInputError(
                "A selected message was already posted.",
                409,
              );
            message.draft = false;
            touched.add(item);
          }
        }

        if (pending.size)
          throw new ReviewInputError("A selected draft no longer exists.", 409);
        submission = {
          id: randomUUID(),
          version: action.version,
          decision: action.decision,
          messageIds: [...new Set(action.messageIds)],
          createdAt: now,
        };
        break;
      }
    }

    return {
      targetId: submission?.id ?? threadId,
      apply: () => {
        for (const item of touched) {
          if (!item.messages.length)
            this.db
              .prepare(
                "DELETE FROM feedback_threads WHERE review_id=? AND id=?",
              )
              .run(reviewId, item.id);
          else
            this.db
              .prepare(
                "INSERT INTO feedback_threads(review_id,id,data) VALUES(?,?,?) ON CONFLICT(review_id,id) DO UPDATE SET data=excluded.data",
              )
              .run(reviewId, item.id, JSON.stringify(item));
        }

        if (submission)
          this.db
            .prepare(
              "INSERT INTO feedback_submissions(review_id,id,data) VALUES(?,?,?)",
            )
            .run(reviewId, submission.id, JSON.stringify(submission));
      },
    };
  }
}
