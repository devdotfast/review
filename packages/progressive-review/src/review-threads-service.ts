import type {
  CreateReviewCommentInput,
  ReviewCommentAgentSession,
  ReviewCommentDraftThreadMap,
  ReviewCommentThreadMap,
  ReviewThreadsCommand,
  ReviewThreadsCommit,
  ReviewThreadsSnapshot,
} from "@dev.fast/review-protocol";

import {
  appendReviewAgentMessage,
  appendReviewComment,
  appendReviewCommentDraft,
  deleteReviewComment,
  deleteReviewCommentDraft,
  deleteReviewCommentDraftMessage,
  deleteReviewCommentMessage,
  readReviewCommentDrafts,
  readReviewComments,
  setReviewCommentAgentSession,
  submitReviewCommentDrafts,
  updateReviewComment,
  updateReviewCommentDraft,
  upsertReviewAgentSessionMessage,
} from "./review-state-store";

export interface ReviewThreadsServiceOptions {
  reviewPath: string;
  author: string;
  onCommit?: (commit: ReviewThreadsCommit) => void;
}

/**
 * Review-owned command boundary for durable Review comment state.
 *
 * SQLite commits first. The service then updates its projection and publishes
 * the exact committed change to every connected Review surface.
 */
export class ReviewThreadsService {
  private comments: ReviewCommentThreadMap;
  private drafts: ReviewCommentDraftThreadMap;
  private revision = 0;
  private readonly listeners = new Set<(commit: ReviewThreadsCommit) => void>();

  constructor(private readonly options: ReviewThreadsServiceOptions) {
    this.comments = readReviewComments(options.reviewPath);
    this.drafts = readReviewCommentDrafts(options.reviewPath);
  }

  snapshot(): ReviewThreadsSnapshot {
    return {
      revision: this.revision,
      comments: this.comments,
      drafts: this.drafts,
    };
  }

  subscribe(listener: (commit: ReviewThreadsCommit) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispatch(command: ReviewThreadsCommand): ReviewThreadsCommit | null {
    switch (command.command) {
      case "comment.create": {
        const result = appendReviewComment(this.options.reviewPath, {
          ...command.input,
          author: this.options.author,
        });
        return this.commit(command.mutationId, {
          upsertedThreads: [result.thread],
        });
      }
      case "comment.update": {
        if (
          !updateReviewComment(
            this.options.reviewPath,
            command.threadId,
            command.update,
          )
        ) {
          return null;
        }
        const thread = readReviewComments(this.options.reviewPath)[
          command.threadId
        ];
        if (!thread) return null;
        return this.commit(command.mutationId, {
          upsertedThreads: [thread],
        });
      }
      case "comment.delete": {
        if (!deleteReviewComment(this.options.reviewPath, command.threadId)) {
          return null;
        }
        return this.commit(command.mutationId, {
          deletedThreadIds: [command.threadId],
        });
      }
      case "comment-message.delete": {
        if (
          !deleteReviewCommentMessage(
            this.options.reviewPath,
            command.threadId,
            command.messageId,
          )
        ) {
          return null;
        }
        const thread = readReviewComments(this.options.reviewPath)[
          command.threadId
        ];
        return thread
          ? this.commit(command.mutationId, { upsertedThreads: [thread] })
          : this.commit(command.mutationId, {
              deletedThreadIds: [command.threadId],
            });
      }
      case "comment-draft.create": {
        const result = appendReviewCommentDraft(this.options.reviewPath, {
          ...command.input,
          author: this.options.author,
        });
        return this.commit(command.mutationId, {
          upsertedDrafts: [result],
        });
      }
      case "comment-draft.update": {
        const draft = updateReviewCommentDraft(
          this.options.reviewPath,
          command.threadId,
          command.update,
        );
        return draft
          ? this.commit(command.mutationId, {
              upsertedDrafts: [{ threadId: command.threadId, draft }],
            })
          : null;
      }
      case "comment-draft.delete": {
        if (
          !deleteReviewCommentDraft(this.options.reviewPath, command.threadId)
        ) {
          return null;
        }
        return this.commit(command.mutationId, {
          deletedDraftThreadIds: [command.threadId],
        });
      }
      case "comment-draft-message.delete": {
        const draft = deleteReviewCommentDraftMessage(
          this.options.reviewPath,
          command.threadId,
          command.messageId,
        );
        if (draft === false) return null;
        return draft
          ? this.commit(command.mutationId, {
              upsertedDrafts: [{ threadId: command.threadId, draft }],
            })
          : this.commit(command.mutationId, {
              deletedDraftThreadIds: [command.threadId],
            });
      }
    }
  }

  submitDrafts(
    mutationId: string,
    inputs: CreateReviewCommentInput[],
  ): ReviewThreadsCommit | null {
    const result = submitReviewCommentDrafts(this.options.reviewPath, inputs);
    if (result.deletedDraftThreadIds.length === 0) return null;
    return this.commit(mutationId, {
      upsertedThreads: result.threads,
      deletedDraftThreadIds: result.deletedDraftThreadIds,
    });
  }

  appendAgentMessage(input: {
    mutationId: string;
    threadId: string;
    messageId: string;
    author: string;
    body: string;
    format: "plain" | "markdown";
  }): ReviewThreadsCommit | null {
    const result = appendReviewAgentMessage(
      this.options.reviewPath,
      input.threadId,
      {
        id: input.messageId,
        by: input.author,
        at: new Date().toISOString(),
        body: input.body,
        role: "agent",
        format: input.format,
        agentInput: false,
      },
    );
    if (!result) return null;
    return result.location === "draft"
      ? this.commit(input.mutationId, {
          upsertedDrafts: [
            {
              threadId: input.threadId,
              draft: result.draft,
            },
          ],
        })
      : this.commit(input.mutationId, { upsertedThreads: [result.thread] });
  }

  upsertAgentSessionMessage(input: {
    mutationId: string;
    threadId: string;
    messageId: string;
    role: "reviewer" | "agent";
    author?: string;
    body: string;
    createdAt?: string;
    agentInput: boolean;
  }): ReviewThreadsCommit | null {
    const current =
      this.drafts[input.threadId]?.thread ?? this.comments[input.threadId];
    const existing = current?.messages.find(
      (message) => message.id === input.messageId,
    );
    const result = upsertReviewAgentSessionMessage(
      this.options.reviewPath,
      input.threadId,
      {
        id: input.messageId,
        by:
          input.role === "agent"
            ? (input.author ?? "Agent")
            : this.options.author,
        at: existing?.at ?? input.createdAt ?? new Date().toISOString(),
        body: input.body,
        role: input.role,
        format: "markdown",
        agentInput: input.agentInput,
      },
    );
    if (!result?.changed) return null;
    return result.location === "draft"
      ? this.commit(input.mutationId, {
          upsertedDrafts: [{ threadId: input.threadId, draft: result.draft }],
        })
      : this.commit(input.mutationId, { upsertedThreads: [result.thread] });
  }

  setAgentSession(input: {
    mutationId: string;
    threadId: string;
    agentSession: ReviewCommentAgentSession;
  }): ReviewThreadsCommit | null {
    const result = setReviewCommentAgentSession(
      this.options.reviewPath,
      input.threadId,
      input.agentSession,
    );
    if (!result) return null;
    return result.location === "draft"
      ? this.commit(input.mutationId, {
          upsertedDrafts: [{ threadId: input.threadId, draft: result.draft }],
        })
      : this.commit(input.mutationId, { upsertedThreads: [result.thread] });
  }

  private commit(
    mutationId: string,
    change: {
      upsertedThreads?: ReviewThreadsCommit["upsertedThreads"];
      deletedThreadIds?: ReviewThreadsCommit["deletedThreadIds"];
      upsertedDrafts?: ReviewThreadsCommit["upsertedDrafts"];
      deletedDraftThreadIds?: ReviewThreadsCommit["deletedDraftThreadIds"];
    },
  ): ReviewThreadsCommit {
    const upsertedThreads = change.upsertedThreads ?? [];
    const deletedThreadIds = change.deletedThreadIds ?? [];
    const upsertedDrafts = change.upsertedDrafts ?? [];
    const deletedDraftThreadIds = change.deletedDraftThreadIds ?? [];
    const comments = { ...this.comments };
    const drafts = { ...this.drafts };
    for (const thread of upsertedThreads) {
      comments[thread.threadId] = thread;
    }
    for (const threadId of deletedThreadIds) {
      delete comments[threadId];
    }
    for (const { threadId, draft } of upsertedDrafts) {
      drafts[threadId] = draft;
    }
    for (const threadId of deletedDraftThreadIds) {
      delete drafts[threadId];
    }
    this.comments = comments;
    this.drafts = drafts;
    const commit = {
      mutationId,
      revision: ++this.revision,
      upsertedThreads,
      deletedThreadIds,
      upsertedDrafts,
      deletedDraftThreadIds,
    } satisfies ReviewThreadsCommit;
    this.options.onCommit?.(commit);
    for (const listener of this.listeners) listener(commit);
    return commit;
  }
}
