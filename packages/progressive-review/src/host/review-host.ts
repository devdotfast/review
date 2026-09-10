import { randomUUID } from "node:crypto";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_LIMITS,
  HOST_QUERY_DEFINITIONS,
  type HostBinding,
  type HostCommand,
  type HostDocument,
  type HostDocumentState,
  HostDocumentValidationError,
  type HostPermission,
  type HostPrincipal,
  type HostQuery,
  type HostQuestionRun,
  type HostRepinPlan,
  type HostReview,
  type JsonValue,
  affectedHostNodeIds,
  applyHostDocumentOperations,
  canonicalHostJson,
} from "@dev.fast/review-protocol";

import { documentCommit } from "./document-commit";
import {
  type HostDocumentEvidenceResources,
  validateHostDocumentEvidence,
} from "./document-evidence";
import { proposeDocumentRepin } from "./document-repin";
import {
  type EvidenceProvider,
  LocalEvidenceProvider,
} from "./evidence-provider";
import {
  LocalRepositorySource,
  resolveBinding,
  resolveRepository,
} from "./local-repository";
import { ReviewFeedback } from "./review-feedback";
import {
  type HostPreparedDocument,
  HostStoreError,
  type HostStoredResponse,
  ReviewHostStore,
} from "./review-host-store";
import { ReviewResources } from "./review-resources";

export interface HostAccess {
  principal: HostPrincipal;
  permissions: ReadonlySet<HostPermission>;
  /** Absent only for the trusted local human/author, never for Ask. */
  reviewIds?: ReadonlySet<string>;
  /** Output credentials are restricted to specific question runs as well. */
  runIds?: ReadonlySet<string>;
}

export class HostAccessError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "HostAccessError";
  }
}

interface HostDependencies {
  evidence?: EvidenceProvider;
  resources?: (reviewId: string) => HostDocumentEvidenceResources;
  onPublishRejected?: () => void | Promise<void>;
  questions?: {
    capabilities(): Promise<HostQuestionRun["harness"][]>;
    start(run: HostQuestionRun): Promise<void>;
  };
}

/** Transport-neutral authority. Source work precedes short synchronous commits;
 * the transaction rechecks receipts and versions before making anything live. */
export class ReviewHost {
  private readonly evidence: EvidenceProvider;
  private readonly source: LocalRepositorySource;
  private readonly resources: ReviewResources;
  private readonly feedback: ReviewFeedback;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly store: ReviewHostStore,
    private readonly dependencies: HostDependencies = {},
  ) {
    const repositoryPath = (id: string) => store.repositoryPath(id);
    this.evidence =
      dependencies.evidence ?? new LocalEvidenceProvider(repositoryPath);
    this.source = new LocalRepositorySource(repositoryPath);
    this.resources = new ReviewResources(store, this.evidence);
    this.feedback = new ReviewFeedback(store, this.evidence, this.source);
  }

  async command(
    access: HostAccess,
    request: HostCommand,
  ): Promise<HostStoredResponse> {
    try {
      return await this.executeCommand(access, request);
    } catch (error) {
      if (request.type === "review.publish") {
        try {
          await this.dependencies.onPublishRejected?.();
        } catch {
          // Telemetry must never replace the actionable publication error.
        }
      }
      throw error;
    }
  }

  private async executeCommand(
    access: HostAccess,
    request: HostCommand,
  ): Promise<HostStoredResponse> {
    this.authorize(
      access,
      request,
      HOST_COMMAND_DEFINITIONS[request.type].permission,
    );
    const identity = {
      clientId: `${access.principal.id}:${request.clientId}`,
      commandId: request.commandId,
      request,
    };
    const replay = this.store.receipt(identity);
    if (replay) return replay;

    // An asynchronous preparation returns a synchronous transaction body. No
    // network/Git work, notifications, or frontend mount occurs inside SQLite.
    let commit: () => JsonValue;
    switch (request.type) {
      case "draft.save":
      case "draft.delete":
      case "thread.create":
      case "thread.reply":
      case "thread.status":
      case "feedback.submit":
      case "question.start":
      case "question.follow_up":
      case "question.retry":
      case "question.complete":
      case "review.attention":
        commit = await this.feedback.prepare(request, access);
        break;
      case "map.create":
      case "map.mutate":
      case "trace.ingest":
      case "asset.upload":
        commit = await this.resources.prepare(request);
        break;
      case "repository.register": {
        const repository = await resolveRepository(request.input.path);
        commit = () => {
          const existing = this.store.repositoryForPath(repository.localPath);
          if (existing)
            return {
              id: existing,
              vcs: repository.vcs,
              displayName: repository.displayName,
            };
          const id = randomUUID();
          this.store.registerRepository({ ...repository, id });
          const result = {
            id,
            vcs: repository.vcs,
            displayName: repository.displayName,
          };
          this.store.appendEvent(null, "repository.registered", result);
          return result;
        };
        break;
      }
      case "review.create": {
        const input = request.input;
        const binding = await resolveBinding(
          input.repositoryId,
          this.store.repositoryPath(input.repositoryId),
          input.change,
        );
        const now = new Date().toISOString();
        const review: HostReview = {
          id: randomUUID(),
          repositoryId: input.repositoryId,
          version: 0,
          title: input.title,
          description: input.description ?? "",
          labels: [],
          workflow: "draft",
          documentId: randomUUID(),
          documentVersion: 0,
          publishedCheckpointId: null,
          authorSessionId: null,
          createdBy: access.principal.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        commit = () => {
          const document = this.store.createReview(review, {
            binding,
            document: {
              schemaVersion: 1,
              roots: [],
              nodes: {},
              definitions: {},
            },
            evidence: {},
          });
          this.store.appendEvent(review.id, "review.created", { review });
          return { review, document };
        };
        break;
      }
      case "review.repin.plan": {
        const input = request.input;
        const document = this.currentDocument(
          input.reviewId,
          input.expectedDocumentVersion,
        );
        const binding = await resolveBinding(
          document.binding.repositoryId,
          this.store.repositoryPath(document.binding.repositoryId),
          input.change,
        );
        const proposal = await proposeDocumentRepin({
          document,
          binding,
          source: this.source,
        });
        const plan: HostRepinPlan = {
          ...proposal,
          id: randomUUID(),
          reviewId: input.reviewId,
          createdAt: new Date().toISOString(),
        };
        commit = () => {
          this.store.saveRepinPlan(plan);
          return plan;
        };
        break;
      }
      case "review.repin.apply": {
        const input = request.input;
        const before = this.currentDocument(
          input.reviewId,
          input.expectedDocumentVersion,
        );
        const plan = this.store.repinPlan(input.reviewId, input.planId);
        if (plan.basedOnDocumentVersion !== before.version)
          throw new HostStoreError(
            "VERSION_CONFLICT",
            "Repin plan describes an older document. Make a new plan.",
          );
        const corrected = new Set(
          input.operations.flatMap((operation) =>
            operation.op === "definition.put" ||
            operation.op === "definition.remove"
              ? [operation.id]
              : [],
          ),
        );
        const unresolved = plan.anchorChanges.filter(
          (anchor) => anchor.status === "missing" && !corrected.has(anchor.id),
        );
        if (unresolved.length)
          throw new HostDocumentValidationError(
            plan.diagnostics.filter((diagnostic) =>
              unresolved.some(
                (anchor) => anchor.id === diagnostic.definitionId,
              ),
            ),
          );
        const proposed = {
          ...documentInput(before),
          definitions: { ...before.definitions, ...plan.proposedDefinitions },
        };
        const document = input.operations.length
          ? applyHostDocumentOperations(
              proposed,
              input.operations,
              this.store.retiredIds(input.reviewId),
            )
          : proposed;
        const prepared = await this.prepare(
          input.reviewId,
          document,
          before,
          plan.binding,
        );
        commit = () => this.commitPrepared(input.reviewId, before, prepared);
        break;
      }
      case "review.update":
      case "review.close":
      case "review.reopen":
      case "review.trash":
      case "review.restore": {
        commit = () => {
          const input = request.input;
          const review = this.store.updateReview(
            input.reviewId,
            input.expectedVersion,
            (before) => {
              const after = {
                ...before,
                version: before.version + 1,
                updatedAt: new Date().toISOString(),
              };
              if (request.type === "review.restore") {
                if (before.deletedAt === null)
                  throw new HostStoreError(
                    "INVALID_STATE",
                    "Review is not in trash.",
                  );
                after.deletedAt = null;
              } else if (before.deletedAt !== null) {
                throw new HostStoreError(
                  "INVALID_STATE",
                  "Restore this review before changing it.",
                );
              } else if (request.type === "review.update") {
                after.title = request.input.title;
                after.description = request.input.description;
                after.labels = request.input.labels;
              } else if (request.type === "review.trash") {
                after.deletedAt = after.updatedAt;
              } else if (request.type === "review.close") {
                if (before.workflow === "closed")
                  throw new HostStoreError(
                    "INVALID_STATE",
                    "Review is already closed.",
                  );
                after.workflow = "closed";
              } else {
                if (before.workflow !== "closed")
                  throw new HostStoreError(
                    "INVALID_STATE",
                    "Review is not closed.",
                  );
                after.workflow = before.publishedCheckpointId
                  ? "in_review"
                  : "draft";
              }
              return after;
            },
          );
          this.store.appendEvent(review.id, "review.updated", { review });
          return review;
        };
        break;
      }
      case "document.mutate":
      case "document.replace":
      case "document.restore": {
        const input = request.input;
        const before = this.currentDocument(
          input.reviewId,
          input.expectedDocumentVersion,
        );
        let prepared: HostPreparedDocument;
        if (request.type === "document.restore") {
          const historical = this.store.document(
            input.reviewId,
            request.input.fromVersion,
          );
          // Historical evidence is already immutable and verified. Restoring it
          // must work even when the local source checkout is no longer present.
          prepared = await this.prepare(
            input.reviewId,
            documentInput(historical),
            historical,
          );
        } else {
          const document =
            request.type === "document.mutate"
              ? applyHostDocumentOperations(
                  documentInput(before),
                  request.input.operations,
                  this.store.retiredIds(input.reviewId),
                )
              : request.input.document;
          if (request.type === "document.replace")
            this.checkRetiredIds(input.reviewId, document);
          prepared = await this.prepare(input.reviewId, document, before);
        }
        commit = () => this.commitPrepared(input.reviewId, before, prepared);
        break;
      }
      case "review.publish": {
        const input = request.input;
        commit = () => {
          this.resources.validatePublication(
            input.reviewId,
            this.currentDocument(input.reviewId, input.expectedDocumentVersion)
              .binding,
            input.mapVersions,
          );
          const checkpoint = this.store.publish({
            ...input,
            principalId: access.principal.id,
          });
          this.store.appendEvent(input.reviewId, "checkpoint.created", {
            checkpoint,
          });
          this.store.appendEvent(input.reviewId, "review.updated", {
            review: this.store.review(input.reviewId),
          });
          return checkpoint;
        };
        break;
      }
      case "canvas.report": {
        const report = request.input;
        const document = this.store.document(
          report.reviewId,
          report.documentVersion,
        );
        if (
          [
            ...report.visibleNodeIds,
            ...report.failures.map((failure) => failure.nodeId),
          ].some((id) => !Object.hasOwn(document.nodes, id))
        )
          throw new HostStoreError(
            "NOT_FOUND",
            "Canvas report names a node outside its observed version.",
          );
        // Reports are bounded observations, not publication or canonical state.
        commit = () => {
          this.store.recordCanvasReport(report, access.principal.id);
          return { accepted: true };
        };
        break;
      }
    }
    let committed = false;
    const response = this.store.command(identity, () => {
      const result =
        HOST_COMMAND_DEFINITIONS[request.type].result.parse(commit());
      committed = true;
      return result;
    });
    if (committed) this.notify();
    if (
      committed &&
      (request.type === "question.start" ||
        request.type === "question.follow_up" ||
        request.type === "question.retry")
    ) {
      const parsed = HOST_COMMAND_DEFINITIONS[request.type].result.parse(
        response.result,
      );
      const run = "run" in parsed ? parsed.run : parsed;
      if (this.dependencies.questions)
        void this.dependencies.questions
          .start(run)
          .catch(() =>
            this.failQuestion(
              run,
              "The local question session could not start. You can retry this saved question.",
            ),
          );
      else
        this.failQuestion(
          run,
          "No local question executor is available. The question has been saved.",
        );
    }
    return response;
  }

  /** Host-owned execution callbacks; never exposed as unrestricted transport mutations. */
  interruptQuestionRuns(): void {
    this.store.command(
      {
        clientId: "host-question-startup",
        commandId: randomUUID(),
        request: {},
      },
      () => {
        for (const run of this.store.interruptOutstandingQuestionRuns())
          this.store.appendEvent(run.reviewId, "question.updated", { run });
        return null;
      },
    );
    this.notify();
  }

  recordQuestionSession(run: HostQuestionRun, sessionId: string): void {
    this.questionTransaction(run, () => {
      const current = this.store.questionRun(run.reviewId, run.id);
      if (current.state !== "pending") return;
      const updated = this.store.updateQuestionRun(run.reviewId, run.id, {
        state: "running",
        sessionId,
        updatedAt: new Date().toISOString(),
      });
      this.store.appendEvent(run.reviewId, "question.updated", {
        run: updated,
      });
    });
  }

  completeQuestion(run: HostQuestionRun, body: string): void {
    this.questionTransaction(run, () => {
      const current = this.store.questionRun(run.reviewId, run.id);
      // A scoped output command may already have saved the final answer.
      if (current.state === "completed") return;
      this.feedback.complete(run.reviewId, run.id, run.id, body, run.assistant);
    });
  }

  failQuestion(run: HostQuestionRun, error: string, interrupted = false): void {
    this.questionTransaction(run, () => {
      const current = this.store.questionRun(run.reviewId, run.id);
      if (current.state !== "pending" && current.state !== "running") return;
      const updated = this.store.updateQuestionRun(run.reviewId, run.id, {
        state: interrupted ? "interrupted" : "failed",
        error: error.slice(0, 4096),
        updatedAt: new Date().toISOString(),
      });
      this.store.appendEvent(run.reviewId, "question.updated", {
        run: updated,
      });
    });
  }

  private questionTransaction(run: HostQuestionRun, write: () => void) {
    this.store.command(
      {
        clientId: "host-question-execution",
        commandId: randomUUID(),
        request: { runId: run.id },
      },
      () => {
        write();
        return null;
      },
    );
    this.notify();
  }

  private notify() {
    // Notification failures cannot turn an already committed command into failure.
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Subscribers recover from their stored cursor. */
      }
    }
  }

  /** Notification only: subscribers always read committed events from storage. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async query(
    access: HostAccess,
    request: HostQuery,
  ): Promise<HostStoredResponse> {
    this.authorize(
      access,
      request,
      HOST_QUERY_DEFINITIONS[request.type].permission,
    );
    if (request.type === "capabilities" && this.dependencies.questions) {
      const supportedHarnesses =
        await this.dependencies.questions.capabilities();
      return this.store.snapshot(() => {
        const result = HOST_QUERY_DEFINITIONS.capabilities.result.parse(
          this.read(access, request),
        );
        return {
          ...result,
          ask: {
            available: supportedHarnesses.length > 0,
            supportedHarnesses,
            isolation: "trusted_local",
          },
        };
      });
    }
    if (request.type === "thread.mapping") {
      const result = await this.feedback.mapping(
        request.input.reviewId,
        request.input.threadId,
        request.input.documentVersion,
      );
      return this.store.snapshot(() => result);
    }
    if (
      request.type === "source.read" ||
      request.type === "source.file" ||
      request.type === "source.tree" ||
      request.type === "source.commits" ||
      request.type === "source.diff"
    ) {
      const document = this.store.document(
        request.input.reviewId,
        request.input.documentVersion,
      );
      let result: JsonValue;
      const scope = `${request.type}:${document.reviewId}:${document.version}`;
      if (request.type === "source.read")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          await this.source.read(document.binding, request.input.range),
        );
      else if (request.type === "source.file")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          await this.source.file(
            document.binding,
            request.input.side,
            request.input.file,
          ),
        );
      else if (request.type === "source.tree")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          page(
            (
              await this.source.tree(
                document.binding,
                request.input.side,
                request.input.directory,
              )
            ).map((entry) => ({ ...entry })),
            request.input,
            `${scope}:${request.input.side}:${request.input.directory ?? ""}`,
            (entry) => entry.path,
          ),
        );
      else if (request.type === "source.commits")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          page(
            (await this.source.commits(document.binding)).map((entry) => ({
              ...entry,
            })),
            request.input,
            scope,
            (entry) => entry.oid,
          ),
        );
      else
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          page(
            (await this.source.diffFiles(document.binding)).map((entry) => ({
              ...entry,
            })),
            request.input,
            scope,
            (entry) => entry.path,
          ),
        );
      return this.store.snapshot(() => result);
    }
    if (request.type === "document.validate") {
      const { reviewId, expectedDocumentVersion, operations } = request.input;
      const previous = this.currentDocument(reviewId, expectedDocumentVersion);
      try {
        const document = applyHostDocumentOperations(
          documentInput(previous),
          operations,
          this.store.retiredIds(reviewId),
        );
        const validated = await this.prepare(reviewId, document, previous);
        return this.store.snapshot(() => ({
          valid: true,
          basedOnVersion: previous.version,
          diagnostics: [],
          affectedNodeIds: affectedHostNodeIds(previous, validated.document),
        }));
      } catch (error) {
        if (!(error instanceof HostDocumentValidationError)) throw error;
        return this.store.snapshot(() => ({
          valid: false,
          basedOnVersion: previous.version,
          diagnostics: error.diagnostics,
          affectedNodeIds: [],
        }));
      }
    }
    return this.store.snapshot(() => {
      const result = this.read(access, request);
      return HOST_QUERY_DEFINITIONS[request.type].result.parse(result);
    });
  }

  events(
    access: HostAccess,
    workspaceId: string,
    after: string,
    reviewId?: string,
  ) {
    this.checkWorkspace(this.store.hostId, workspaceId);
    this.requirePermission(access, "read");
    if (reviewId) this.checkReview(access, reviewId);
    if (access.reviewIds && !reviewId)
      throw new HostAccessError(
        "FORBIDDEN",
        "This credential must subscribe to its granted review.",
      );
    const input: Parameters<ReviewHostStore["events"]>[1] = {
      principalId: access.principal.id,
    };
    if (reviewId) input.reviewId = reviewId;
    return this.store.events(after, input);
  }

  private read(
    access: HostAccess,
    request: Exclude<
      HostQuery,
      {
        type:
          | "document.validate"
          | "source.read"
          | "source.file"
          | "thread.mapping"
          | "source.tree"
          | "source.commits"
          | "source.diff";
      }
    >,
  ): JsonValue {
    switch (request.type) {
      case "canvas.reports":
        return this.store.canvasReports(request.input.reviewId);
      case "drafts.list":
      case "threads.list":
      case "thread.get":
      case "feedback.list":
      case "feedback.get":
      case "question.get":
      case "question.context":
      case "questions.list":
      case "attention.get":
        return this.feedback.query(request, access.principal);
      case "map.get":
      case "maps.list":
      case "trace.get":
      case "asset.get":
        return this.resources.query(request);
      case "capabilities":
        return {
          apiVersions: [1],
          documentSchemaVersions: [1],
          nodeTypes: [
            "markdown",
            "heading",
            "paragraph",
            "code",
            "divider",
            "section",
            "callout",
            "code_peek",
            "sequence",
            "call_stack_diff",
            "database_lens",
            "trace_quote",
            "image",
            "software_map",
          ],
          limits: HOST_LIMITS,
          commands: Object.entries(HOST_COMMAND_DEFINITIONS)
            .filter(([, value]) => access.permissions.has(value.permission))
            .map(([name]) => name),
          queries: Object.entries(HOST_QUERY_DEFINITIONS)
            .filter(([, value]) => access.permissions.has(value.permission))
            .map(([name]) => name),
          rendererVersion: "json-1",
          source: { read: true, navigation: false },
          ask: {
            available: false,
            supportedHarnesses: [],
            isolation: "trusted_local",
          },
        };
      case "repositories.list": {
        const permitted = access.reviewIds
          ? new Set(
              this.store
                .reviews(true)
                .filter((review) => access.reviewIds!.has(review.id))
                .map((review) => review.repositoryId),
            )
          : null;
        return page(
          this.store
            .repositories()
            .filter((repository) => !permitted || permitted.has(repository.id)),
          request.input,
          "repositories",
          (repository) => repository.id,
        );
      }
      case "reviews.list": {
        const input = request.input;
        const reviews = this.store
          .reviews(input.includeTrash)
          .filter(
            (review) =>
              (!access.reviewIds || access.reviewIds.has(review.id)) &&
              (!input.repositoryId ||
                review.repositoryId === input.repositoryId) &&
              (!input.workflow || review.workflow === input.workflow),
          );
        return page(
          reviews,
          input,
          `reviews:${input.repositoryId ?? ""}:${input.workflow ?? ""}:${input.includeTrash ?? false}`,
          (review) => review.id,
        );
      }
      case "review.get":
        return { review: this.store.review(request.input.reviewId) };
      case "repin_plan.get":
        return this.store.repinPlan(
          request.input.reviewId,
          request.input.planId,
        );
      case "document.get":
        return this.store.document(
          request.input.reviewId,
          request.input.version,
        );
      case "document.nodes": {
        const document = this.store.document(
          request.input.reviewId,
          request.input.version,
        );
        return {
          version: document.version,
          nodes: request.input.ids.map((id) => {
            const node = document.nodes[id];
            if (!node)
              throw new HostStoreError(
                "NOT_FOUND",
                "Requested node does not exist in this version.",
              );
            return node;
          }),
        };
      }
      case "document.evidence": {
        const document = this.store.document(
          request.input.reviewId,
          request.input.version,
        );
        return {
          version: document.version,
          evidence: Object.fromEntries(
            request.input.anchorIds.map((id) => {
              const evidence = document.evidence[id];
              if (!evidence)
                throw new HostStoreError(
                  "NOT_FOUND",
                  "Requested evidence does not exist in this version.",
                );
              return [id, evidence];
            }),
          ),
        };
      }
      case "document.history":
        return page(
          this.store.documentHistory(request.input.reviewId),
          request.input,
          `history:${request.input.reviewId}`,
          (version) => String(version.version),
        );
      case "checkpoints.list":
        return page(
          this.store.checkpoints(request.input.reviewId),
          request.input,
          `checkpoints:${request.input.reviewId}`,
          (checkpoint) => checkpoint.id,
        );
      case "checkpoint.get": {
        const checkpoint = this.store.checkpoint(
          request.input.reviewId,
          request.input.checkpointId,
        );
        return {
          checkpoint,
          document: this.store.document(
            checkpoint.reviewId,
            checkpoint.documentVersion,
          ),
        };
      }
    }
  }

  private authorize(
    access: HostAccess,
    request: HostCommand | HostQuery,
    permission: HostPermission,
  ) {
    this.checkWorkspace(request.hostId, request.workspaceId);
    this.requirePermission(access, permission);
    if ("reviewId" in request.input)
      this.checkReview(access, request.input.reviewId);
    else if (
      access.reviewIds &&
      (request.type === "review.create" ||
        request.type === "repository.register")
    )
      throw new HostAccessError(
        "FORBIDDEN",
        "This credential cannot create reviews or register repositories.",
      );
  }
  private requirePermission(access: HostAccess, permission: HostPermission) {
    if (!access.permissions.has(permission))
      throw new HostAccessError(
        "FORBIDDEN",
        "This credential does not permit that operation.",
      );
    if (permission === "human" && access.principal.kind !== "human")
      throw new HostAccessError(
        "FORBIDDEN",
        "This operation requires the local human.",
      );
  }
  private checkWorkspace(hostId: string, workspaceId: string) {
    if (hostId !== this.store.hostId || workspaceId !== this.store.workspaceId)
      throw new HostAccessError("NOT_FOUND", "Host or workspace not found.");
  }
  private checkReview(access: HostAccess, reviewId: string) {
    if (access.reviewIds && !access.reviewIds.has(reviewId))
      throw new HostAccessError("NOT_FOUND", "Review not found.");
  }
  private currentDocument(reviewId: string, expectedVersion: number) {
    const review = this.store.review(reviewId);
    if (review.documentVersion !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Document changed. Read the current version and retry.",
      );
    if (review.deletedAt !== null || review.workflow === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
    return this.store.document(reviewId);
  }
  private async prepare(
    reviewId: string,
    document: HostDocument,
    previous: HostDocumentState,
    binding: HostBinding = previous.binding,
  ): Promise<HostPreparedDocument> {
    const { evidence } = await validateHostDocumentEvidence({
      document,
      binding,
      previous,
      provider: this.evidence,
      resources:
        this.dependencies.resources?.(reviewId) ??
        this.resources.lookups(reviewId),
      changedLines: (binding, file, side) =>
        this.source.changedLines(binding, file, side),
    });
    return { document, binding, evidence };
  }
  private commitPrepared(
    reviewId: string,
    before: HostDocumentState,
    prepared: HostPreparedDocument,
  ) {
    const after = this.store.commitDocument(reviewId, before.version, prepared);
    const result = documentCommit(before, after);
    if (after.version !== before.version) {
      const event = { reviewId, commit: result };
      if (Buffer.byteLength(canonicalHostJson(event)) <= 256 * 1024)
        this.store.appendEvent(reviewId, "document.committed", event);
      else
        this.store.appendEvent(reviewId, "document.resync_required", {
          reviewId,
          version: after.version,
        });
    }
    return result;
  }
  private checkRetiredIds(reviewId: string, document: HostDocument) {
    const retired = this.store.retiredIds(reviewId);
    if (
      Object.keys(document.nodes).some((id) => retired.nodeIds.has(id)) ||
      Object.keys(document.definitions).some((id) =>
        retired.definitionIds.has(id),
      )
    )
      throw new HostStoreError(
        "INVALID_STATE",
        "Removed IDs cannot be reused. Use document.restore to restore historical content.",
      );
  }
}

export function documentInput(state: HostDocumentState): HostDocument {
  return {
    schemaVersion: state.schemaVersion,
    roots: state.roots,
    nodes: state.nodes,
    definitions: state.definitions,
  };
}

/** Stable-key pagination: later inserts do not shift the next page by an offset. */
function page<T extends JsonValue>(
  items: T[],
  input: { cursor?: string; limit?: number },
  scope: string,
  key: (item: T) => string,
) {
  let start = 0;
  if (input.cursor) {
    const prefix = `${scope}:`;
    const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
    if (!decoded.startsWith(prefix))
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Page cursor belongs to a different query.",
      );
    const index = items.findIndex(
      (item) => key(item) === decoded.slice(prefix.length),
    );
    if (index < 0)
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Page changed; restart the query.",
      );
    start = index + 1;
  }
  const limit = input.limit ?? 100;
  const selected = items.slice(start, start + limit);
  return {
    items: selected,
    nextCursor:
      start + selected.length < items.length
        ? Buffer.from(`${scope}:${key(selected.at(-1)!)}`).toString("base64url")
        : null,
  };
}
