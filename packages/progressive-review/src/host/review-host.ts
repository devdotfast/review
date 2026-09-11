import { randomUUID } from "node:crypto";

import {
  HOST_CAPABILITY_LIMITS,
  HOST_COMMAND_DEFINITIONS,
  HOST_QUERY_DEFINITIONS,
  type HostActivitySnapshot,
  type HostBinding,
  type HostCommand,
  type HostDocument,
  HostDocumentSchema,
  type HostDocumentState,
  HostDocumentValidationError,
  HostNodeSchema,
  type HostPermission,
  type HostPrincipal,
  type HostQuery,
  type HostQuestionRun,
  type HostReviewCommit,
  type HostReviewState,
  type JsonValue,
  affectedHostNodeIds,
  applyHostDocumentOperations,
  canonicalHostJson,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { documentCommit } from "./document-commit";
import {
  type HostDocumentEvidenceResources,
  validateHostDocumentEvidence,
} from "./document-evidence";
import {
  type EvidenceProvider,
  LocalEvidenceProvider,
} from "./evidence-provider";
import {
  LocalRepositorySource,
  resolveBinding,
  resolveRepository,
} from "./local-repository";
import { ReviewActivity } from "./review-activity";
import { ReviewFeedback } from "./review-feedback";
import {
  type HostPreparedDocument,
  type HostReviewCommitOptions,
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
  authoringActivity?: boolean;
  evidence?: EvidenceProvider;
  resources?: (reviewId: string) => HostDocumentEvidenceResources;
  questions?: {
    capabilities(): Promise<HostQuestionRun["harness"][]>;
    start(run: HostQuestionRun): Promise<void>;
    defaultHarness?(): HostQuestionRun["harness"] | undefined;
  };
}

/** Transport-neutral authority. Source work precedes short synchronous commits;
 * the transaction rechecks receipts and versions before making anything live. */
export class ReviewHost {
  private readonly evidence: EvidenceProvider;
  private readonly source: LocalRepositorySource;
  private readonly resources: ReviewResources;
  private readonly feedback: ReviewFeedback;
  private readonly activity: ReviewActivity | undefined;
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
    this.feedback = new ReviewFeedback(
      store,
      this.evidence,
      this.source,
      dependencies.questions,
    );
    if (
      dependencies.authoringActivity ??
      process.env.DEV_REVIEW_AUTHORING_ACTIVITY === "1"
    )
      this.activity = new ReviewActivity();
  }

  async command(
    access: HostAccess,
    request: HostCommand,
  ): Promise<HostStoredResponse> {
    this.authorize(
      access,
      request,
      HOST_COMMAND_DEFINITIONS[request.type].permission,
    );
    return this.executeCommand(access, request);
  }

  private async executeCommand(
    access: HostAccess,
    request: HostCommand,
  ): Promise<HostStoredResponse> {
    if (
      request.type === "authoring.begin" ||
      request.type === "authoring.renew" ||
      request.type === "authoring.end"
    ) {
      const activity = this.requireActivity();
      this.store.review(request.input.reviewId);
      return {
        result: activity.command(access.principal.id, request),
        eventCursor: this.store.cursor(),
      };
    }
    const identity = {
      clientId: `${access.principal.id}:${request.clientId}`,
      commandId: request.commandId,
      request: parseJsonText(JSON.stringify(request)),
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
      case "thread.set_status":
      case "feedback.submit":
      case "question.start":
      case "question.follow_up":
      case "question.retry":
      case "question.complete":
      case "attention.update":
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
        const review: HostReviewState = {
          id: randomUUID(),
          repositoryId: input.repositoryId,
          latestReviewVersion: 0,
          stateVersion: 0,
          state: "open",
          createdBy: access.principal.id,
          createdAt: now,
          deletedAt: null,
        };
        commit = () => {
          const document = this.store.createReview(
            review,
            {
              binding,
              document: {
                schemaVersion: 1,
                roots: [],
                nodes: {},
                definitions: {},
              },
              evidence: {},
            },
            {
              title: input.title,
              description: input.description ?? "",
              labels: input.labels ?? [],
              mapVersions: { base: null, head: null },
            },
          );
          const snapshot = this.store.reviewSnapshot(review.id);
          this.store.appendEvent(review.id, "review.created", {
            review,
            snapshot,
          });
          return { review, snapshot, document };
        };
        break;
      }
      case "review.update": {
        const input = request.input;
        const before = this.currentDocument(
          input.reviewId,
          input.expectedReviewVersion,
        );
        const prior = this.store.reviewSnapshot(
          input.reviewId,
          before.reviewVersion,
        );
        const metadata = {
          title: input.title ?? prior.title,
          description: input.description ?? prior.description,
          labels: input.labels ?? prior.labels,
          mapVersions: { ...prior.mapVersions, ...input.mapVersions },
        };
        this.resources.validateSelectedMaps(
          input.reviewId,
          before.binding,
          metadata.mapVersions,
        );
        commit = () => {
          this.resources.validateSelectedMaps(
            input.reviewId,
            before.binding,
            metadata.mapVersions,
          );
          return this.commitPrepared(
            input.reviewId,
            before,
            {
              document: documentInput(before),
              binding: before.binding,
              evidence: before.evidence,
            },
            { metadata, principalId: access.principal.id, reason: "metadata" },
          );
        };
        break;
      }
      case "review.close":
      case "review.reopen":
      case "review.trash":
      case "review.untrash": {
        const input = request.input;
        commit = () => {
          const prior = this.store.review(input.reviewId);
          const review = this.store.updateReviewState(
            input.reviewId,
            input.expectedStateVersion,
            (before) => {
              if (request.type === "review.untrash")
                return { ...before, deletedAt: null };
              if (request.type === "review.trash")
                return {
                  ...before,
                  deletedAt: before.deletedAt ?? new Date().toISOString(),
                };
              if (before.deletedAt !== null)
                throw new HostStoreError(
                  "INVALID_STATE",
                  "Untrash this review before changing its lifecycle.",
                );
              return {
                ...before,
                state: request.type === "review.close" ? "closed" : "open",
              };
            },
          );
          if (review.stateVersion !== prior.stateVersion)
            this.store.appendEvent(review.id, "review.state_changed", {
              review,
            });
          return review;
        };
        break;
      }
      case "review.revision.create": {
        const input = request.input;
        const before = this.currentDocument(
          input.reviewId,
          input.expectedReviewVersion,
        );
        const prior = this.store.reviewSnapshot(
          input.reviewId,
          before.reviewVersion,
        );
        const binding = await resolveBinding(
          before.binding.repositoryId,
          this.store.repositoryPath(before.binding.repositoryId),
          input.change,
        );
        if (
          binding.baseCommit === before.binding.baseCommit &&
          binding.headCommit === before.binding.headCommit
        )
          throw new HostStoreError(
            "INVALID_STATE",
            "The selected code commits have not changed.",
          );
        const prepared = {
          binding,
          document: {
            schemaVersion: 1 as const,
            roots: [],
            nodes: {},
            definitions: {},
          },
          evidence: {},
        };
        commit = () =>
          this.commitPrepared(input.reviewId, before, prepared, {
            principalId: access.principal.id,
            reason: "source",
            metadata: {
              title: prior.title,
              description: prior.description,
              labels: prior.labels,
              mapVersions: { base: null, head: null },
            },
          });
        break;
      }
      case "document.mutate":
      case "document.replace":
      case "review.version.restore": {
        const input = request.input;
        const before = this.currentDocument(
          input.reviewId,
          input.expectedReviewVersion,
        );
        let prepared: HostPreparedDocument;
        let options: HostReviewCommitOptions = {
          principalId: access.principal.id,
          reason: "document",
        };
        if (request.type === "review.version.restore") {
          const historical = this.store.document(
            input.reviewId,
            request.input.fromReviewVersion,
          );
          const snapshot = this.store.reviewSnapshot(
            input.reviewId,
            request.input.fromReviewVersion,
          );
          // Retained source and resource identities make historical restore independent of Git availability.
          prepared = {
            document: documentInput(historical),
            binding: historical.binding,
            evidence: historical.evidence,
          };
          options = {
            ...options,
            reason: "restore",
            force: true,
            restoredFromReviewVersion: request.input.fromReviewVersion,
            metadata: {
              title: snapshot.title,
              description: snapshot.description,
              labels: snapshot.labels,
              mapVersions: snapshot.mapVersions,
            },
          };
        } else {
          const document =
            request.type === "document.mutate"
              ? applyHostDocumentOperations(
                  documentInput(before),
                  request.input.operations,
                  this.store.retiredIds(input.reviewId),
                )
              : HostDocumentSchema.parse(request.input.document);
          if (request.type === "document.replace")
            this.checkRetiredIds(input.reviewId, document);
          this.checkRetiredItemIds(input.reviewId, document);
          prepared = await this.prepare(input.reviewId, document, before);
        }
        commit = () =>
          this.commitPrepared(input.reviewId, before, prepared, options);
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
      this.feedback.complete(run.reviewId, run.id, body, run.assistant);
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

  activitySnapshot(
    access: HostAccess,
    workspaceId: string,
    reviewId: string,
  ): HostActivitySnapshot {
    this.checkWorkspace(this.store.hostId, workspaceId);
    this.requirePermission(access, "read");
    this.checkReview(access, reviewId);
    this.store.review(reviewId);
    return this.requireActivity().snapshot(reviewId);
  }

  subscribeActivity(reviewId: string, listener: () => void): () => void {
    return this.requireActivity().subscribe((changed) => {
      if (changed === reviewId) listener();
    });
  }

  closeAuthoringActivity(): void {
    this.activity?.close();
  }

  private requireActivity(): ReviewActivity {
    if (!this.activity)
      throw new HostAccessError(
        "NOT_FOUND",
        "Authoring activity prototype is not enabled.",
      );
    return this.activity;
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
            defaultHarness: this.effectiveDefaultHarness(supportedHarnesses),
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
        request.input.reviewVersion,
      );
      return this.store.snapshot(() => result);
    }
    if (
      request.type === "source.read" ||
      request.type === "source.tree" ||
      request.type === "source.commits" ||
      request.type === "source.diff" ||
      request.type === "map.analyze"
    ) {
      const document = this.store.document(
        request.input.reviewId,
        request.input.reviewVersion,
      );
      let result: JsonValue;
      const scope = `${request.type}:${document.reviewId}:${document.reviewVersion}`;
      if (request.type === "source.read")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          await this.source.read(document.binding, request.input),
        );
      else if (request.type === "source.tree")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          page(
            (
              await this.source.tree(
                document.binding,
                request.input.side,
                request.input.directory,
                request.input.comparisonCommit,
              )
            ).map((entry) => ({ ...entry })),
            request.input,
            `${scope}:${request.input.side}:${request.input.directory ?? ""}:${request.input.comparisonCommit ?? "full"}`,
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
      else if (request.type === "map.analyze")
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          await this.resources.analyze(request.input, this.source),
        );
      else
        result = HOST_QUERY_DEFINITIONS[request.type].result.parse(
          page(
            (
              await this.source.diffFiles(
                document.binding,
                request.input.comparisonCommit,
              )
            ).map((entry) => ({
              ...entry,
            })),
            request.input,
            `${scope}:${request.input.comparisonCommit ?? "full"}`,
            (entry) => entry.path,
          ),
        );
      return this.store.snapshot(() => result);
    }
    if (request.type === "document.validate") {
      const { reviewId, expectedReviewVersion, operations } = request.input;
      // Capture the candidate and cursor together before any asynchronous source
      // work. Later edits must remain replayable from this validation response.
      const captured = this.store.snapshot(() => {
        const previous = this.currentDocument(reviewId, expectedReviewVersion);
        try {
          const document = applyHostDocumentOperations(
            documentInput(previous),
            operations,
            this.store.retiredIds(reviewId),
          );
          this.checkRetiredItemIds(reviewId, document);
          return { previous, document, diagnostics: [] };
        } catch (error) {
          if (!(error instanceof HostDocumentValidationError)) throw error;
          return { previous, document: null, diagnostics: error.diagnostics };
        }
      });
      const { previous, document, diagnostics } = captured.result;
      const invalid = (errors: typeof diagnostics): HostStoredResponse => ({
        result: HOST_QUERY_DEFINITIONS["document.validate"].result.parse({
          valid: false,
          basedOnReviewVersion: previous.reviewVersion,
          diagnostics: errors,
          affectedNodeIds: [],
        }),
        eventCursor: captured.eventCursor,
      });
      if (!document) return invalid(diagnostics);
      try {
        const validated = await this.prepare(reviewId, document, previous);
        return {
          result: HOST_QUERY_DEFINITIONS["document.validate"].result.parse({
            valid: true,
            basedOnReviewVersion: previous.reviewVersion,
            diagnostics: [],
            affectedNodeIds: affectedHostNodeIds(previous, validated.document),
          }),
          eventCursor: captured.eventCursor,
        };
      } catch (error) {
        if (!(error instanceof HostDocumentValidationError)) throw error;
        return invalid(error.diagnostics);
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
          | "thread.mapping"
          | "source.tree"
          | "source.commits"
          | "map.analyze"
          | "source.diff";
      }
    >,
  ): JsonValue {
    switch (request.type) {
      case "authoring.get":
        this.store.review(request.input.reviewId);
        return this.requireActivity().snapshot(request.input.reviewId);
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
          nodeTypes: HostNodeSchema.options.map(
            (node) => node.shape.type.value,
          ),
          limits: HOST_CAPABILITY_LIMITS,
          commands: Object.entries(HOST_COMMAND_DEFINITIONS)
            .filter(
              ([name, value]) =>
                access.permissions.has(value.permission) &&
                (this.activity || !name.startsWith("authoring.")),
            )
            .map(([name]) => name),
          queries: Object.entries(HOST_QUERY_DEFINITIONS)
            .filter(
              ([name, value]) =>
                access.permissions.has(value.permission) &&
                (this.activity || !name.startsWith("authoring.")),
            )
            .map(([name]) => name),
          ask: {
            defaultHarness: null,
            supportedHarnesses: [],
            isolation: "trusted_local",
          },
        };
      case "repositories.list": {
        const scope = `repositories:${this.store.hostId}:${access.principal.id}`;
        const upper = collectionPageBoundary(
          request.input,
          scope,
          this.store.collectionBoundary("repositories"),
        );
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
            .repositories(upper)
            .filter((repository) => !permitted || permitted.has(repository.id)),
          request.input,
          scope,
          (repository) => repository.id,
          upper,
        );
      }
      case "reviews.list": {
        const input = request.input;
        const scope = `reviews:${this.store.hostId}:${access.principal.id}:${input.repositoryId ?? ""}:${input.state ?? ""}:${input.includeTrash ?? false}`;
        const upper = collectionPageBoundary(
          input,
          scope,
          this.store.collectionBoundary("reviews"),
        );
        const reviews = this.store
          .reviews(input.includeTrash, upper)
          .filter(
            (review) =>
              (!access.reviewIds || access.reviewIds.has(review.id)) &&
              (!input.repositoryId ||
                review.repositoryId === input.repositoryId) &&
              (!input.state || review.state === input.state),
          );
        return page(
          reviews.map((review) => ({
            review,
            snapshot: this.store.reviewSnapshot(review.id),
          })),
          input,
          scope,
          (entry) => entry.review.id,
          upper,
        );
      }
      case "review.get":
        return {
          review: this.store.review(request.input.reviewId),
          snapshot: this.store.reviewSnapshot(
            request.input.reviewId,
            request.input.reviewVersion,
          ),
        };
      case "document.get":
        return this.store.document(
          request.input.reviewId,
          request.input.reviewVersion,
        );
      case "document.nodes": {
        const document = this.store.document(
          request.input.reviewId,
          request.input.reviewVersion,
        );
        return {
          reviewVersion: document.reviewVersion,
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
          request.input.reviewVersion,
        );
        return {
          reviewVersion: document.reviewVersion,
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
      case "review.history":
        return page(
          this.store.reviewHistory(request.input.reviewId),
          request.input,
          `history:${request.input.reviewId}`,
          (item) => String(item.reviewVersion),
        );
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
    if (review.latestReviewVersion !== expectedVersion)
      throw new HostStoreError(
        "VERSION_CONFLICT",
        "Document changed. Read the current version and retry.",
        review.latestReviewVersion,
      );
    if (review.deletedAt !== null || review.state === "closed")
      throw new HostStoreError(
        "INVALID_STATE",
        "Closed or trashed reviews cannot be authored.",
      );
    return this.store.document(reviewId, expectedVersion);
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
    options: HostReviewCommitOptions = {},
  ): HostReviewCommit {
    const after = this.store.commitDocument(
      reviewId,
      before.reviewVersion,
      prepared,
      options,
    );
    const changedDocument = after.contentHash !== before.contentHash;
    const result: HostReviewCommit = {
      reviewId,
      previousReviewVersion: before.reviewVersion,
      reviewVersion: after.reviewVersion,
      snapshot: this.store.reviewSnapshot(reviewId, after.reviewVersion),
      documentDelta: changedDocument ? documentCommit(before, after) : null,
      diagnostics: [],
    };
    if (after.reviewVersion !== before.reviewVersion) {
      const event = result;
      if (Buffer.byteLength(canonicalHostJson(event)) <= 256 * 1024)
        this.store.appendEvent(reviewId, "review.committed", event);
      else
        this.store.appendEvent(reviewId, "review.resync_required", {
          reviewId,
          reviewVersion: after.reviewVersion,
        });
    }
    return result;
  }

  private effectiveDefaultHarness(
    supported: HostQuestionRun["harness"][],
  ): HostQuestionRun["harness"] | null {
    const configured = this.dependencies.questions?.defaultHarness?.();
    return configured && supported.includes(configured)
      ? configured
      : supported.length === 1
        ? supported[0]!
        : null;
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
        "Removed IDs cannot be reused. Use review.version.restore to restore historical content.",
      );
  }

  private checkRetiredItemIds(reviewId: string, document: HostDocument): void {
    const reused = this.store.reusedDocumentItems(reviewId, document);
    if (reused.length)
      throw new HostDocumentValidationError(
        reused.map((item) => ({
          severity: "error",
          code: "RETIRED_ID",
          path: `/candidate/document${item.path}`,
          nodeId: item.nodeId,
          message:
            "Removed diagram item IDs cannot be reused. Restore the historical review version or use fresh IDs.",
        })),
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

const PageCursorSchema = z.strictObject({
  scope: z.string(),
  after: z.string(),
  upper: z.number().int().nonnegative().nullable(),
});
function readPageCursor(cursor: string, scope: string) {
  try {
    const parsed = PageCursorSchema.parse(
      parseJsonText(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.scope === scope) return parsed;
  } catch {
    /* Malformed and differently scoped cursors both require a fresh traversal. */
  }
  throw new HostStoreError(
    "CURSOR_EXPIRED",
    "Page cursor belongs to a different query or is invalid.",
  );
}
function collectionPageBoundary(
  input: { cursor?: string },
  scope: string,
  current: number,
): number {
  if (!input.cursor) return current;
  const { upper } = readPageCursor(input.cursor, scope);
  if (upper !== null && upper <= current) return upper;
  throw new HostStoreError(
    "CURSOR_EXPIRED",
    "Page insertion boundary is no longer available.",
  );
}

/** Stable-key pagination, with a retained insertion bound for mutable collections. */
function page<T extends JsonValue>(
  items: T[],
  input: { cursor?: string; limit?: number },
  scope: string,
  key: (item: T) => string,
  upper: number | null = null,
) {
  let start = 0;
  if (input.cursor) {
    const decoded = readPageCursor(input.cursor, scope);
    if (decoded.upper !== upper)
      throw new HostStoreError(
        "CURSOR_EXPIRED",
        "Page cursor has a different insertion boundary.",
      );
    const index = items.findIndex((item) => key(item) === decoded.after);
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
        ? Buffer.from(
            canonicalHostJson({ scope, after: key(selected.at(-1)!), upper }),
          ).toString("base64url")
        : null,
  };
}
