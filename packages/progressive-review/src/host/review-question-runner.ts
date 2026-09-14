import { randomBytes } from "node:crypto";

import type { HostQuestionRun } from "@dev.fast/review-protocol";

import type { HostCredentials } from "./host-credentials";
import { LocalQuestionExecutor } from "./local-question-executor";
import type { ReviewHost } from "./review-host";

/** Execution is replaceable; questions, context and completed answers belong
 * to ReviewHost. Tokens live only for this process/run and are never persisted. */
export class ReviewQuestionRunner {
  private readonly credentials = new Set<() => void>();
  private closing = false;

  constructor(
    private readonly options: {
      host: ReviewHost;
      credentials: HostCredentials;
      executor: LocalQuestionExecutor;
      baseUrl(): string;
    },
  ) {}

  async capabilities(): Promise<HostQuestionRun["harness"][]> {
    if (this.closing) return [];
    return (await this.options.executor.capabilities()).flatMap((capability) =>
      capability.available && capability.harness !== "opencode"
        ? [capability.harness]
        : [],
    );
  }

  async start(run: HostQuestionRun): Promise<void> {
    if (this.closing) return;
    const { host, executor } = this.options;
    const token = randomBytes(32).toString("base64url");
    const revoke = this.options.credentials.add(token, {
      principal: run.assistant,
      permissions: new Set(["read", "answer"]),
      reviewIds: new Set([run.reviewId]),
      runIds: new Set([run.id]),
    });
    this.credentials.add(revoke);
    const cleanup = () => {
      revoke();
      this.credentials.delete(revoke);
    };
    try {
      const context = host.store.questionContext(run.reviewId, run.contextId);
      const document = host.store.document(run.reviewId, context.reviewVersion);
      const handle = await executor.start({
        runId: run.id,
        questionId: run.questionId,
        harness: run.harness,
        repositoryPath: host.store.repositoryPath(
          document.binding.repositoryId,
        ),
        context,
        credentials: {
          url: this.options.baseUrl(),
          token,
          hostId: host.store.hostId,
          workspaceId: host.store.workspaceId,
        },
        onCompleted: async (answer) => {
          if (!this.closing) {
            host.recordQuestionSession(run, answer.session.sessionId);
            host.completeQuestion(run, answer.body);
          }
        },
      });
      if (this.closing) {
        cleanup();
        return;
      }
      host.recordQuestionSession(run, handle.session.sessionId);
      void handle.completion
        .then((outcome) => {
          if (this.closing || outcome.status === "completed") return;
          host.failQuestion(
            run,
            outcome.error.message,
            outcome.status === "interrupted",
          );
        })
        .catch(() => {
          if (!this.closing)
            host.failQuestion(
              run,
              "The question session ended without a saved answer. You can retry it.",
            );
        })
        .finally(cleanup);
    } catch {
      cleanup();
      if (!this.closing)
        host.failQuestion(
          run,
          "The local question session could not start. The question is saved and can be retried.",
        );
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const revoke of this.credentials) revoke();
    this.credentials.clear();
    // Closing the observation stream does not claim to stop external agents.
    await this.options.executor.close();
    this.options.host.interruptQuestionRuns();
  }
}
