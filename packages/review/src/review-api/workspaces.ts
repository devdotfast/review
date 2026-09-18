import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { git, gitCommonDir } from "@dev.fast/local-vcs";
import { errorMessage, processIsAlive } from "@dev.fast/trace-core";

import { reviewManagedCheckoutRoot } from "../review-checkout-paths.js";
import { ensureReviewPinnedCheckout } from "../review-head-checkout.js";
import {
  markerMatches,
  prepareReviewPinnedCheckout,
  removeReviewPrepareArtifacts,
  reviewPrepareCommandsHash,
  reviewPrepareLogPath,
  reviewPrepareMarkerPath,
} from "../review-prepare.js";
import { type Pins, ReviewInputError } from "./document.js";
import type { ReviewStore } from "./store.js";

export interface WorkspaceStatus {
  id: string;
  commit: string;
  rootPath: string | null;
  generation: string;
  state:
    | "pending"
    | "preparing"
    | "ready"
    | "unconfigured"
    | "failed"
    | "cleanup-failed";
  log: string;
  /** Acquisition failed; this can be transient. Optional setup failures are not issues. */
  issue?: string;
}

interface Environment extends WorkspaceStatus {
  reviewId: string;
  repositoryId: string;
  repository: string;
  commandsHash: string;
  role: "base" | "head";
}

/** Local lifecycle only: source and authored history never depend on preparation.
 * Status/queue/process lifecycle follows #334, retaining the legacy prepare config
 * and per-review managed checkout layout instead of a new settings system.
 */
export class ReviewWorkspaces {
  private readonly db: DatabaseSync;
  private readonly requests = new Map<string, Promise<WorkspaceStatus>>();
  private readonly jobs = new Map<
    string,
    { done: Promise<void>; abort: AbortController }
  >();
  private readonly stop: () => void;
  private cleanup: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly ownerId = randomUUID();

  constructor(
    databasePath: string,
    private readonly store: ReviewStore,
  ) {
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS pinned_environments(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workspace_owner(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL)",
    );
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const owner = this.db
        .prepare("SELECT pid FROM workspace_owner WHERE id=1")
        .get();

      if (owner && processIsAlive(Number(owner.pid)))
        throw new ReviewInputError(
          "Another Desktop owns this profile's language workspaces. Close that Desktop before opening another instance.",
          409,
        );
      this.db
        .prepare("INSERT OR REPLACE INTO workspace_owner VALUES(1,?,?)")
        .run(this.ownerId, process.pid);

      // Only the owning Desktop can invalidate generations or recover interrupted preparation.
      for (const environment of this.all()) {
        if (environment.state === "preparing") environment.state = "pending";
        environment.generation = randomUUID();
        this.save(environment);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }

    this.stop = store.subscribeCatalog(() => this.collect());
    this.collect();
  }

  private external?: {
    has(id: string): boolean;
    subscribe(listener: () => void): () => void;
  };
  private stopExternal?: () => void;

  attachExternalReviews(source: {
    has(id: string): boolean;
    subscribe(listener: () => void): () => void;
  }) {
    if (this.external === source) return;
    this.stopExternal?.();
    this.external = source;
    this.stopExternal = source.subscribe(() => this.collect());
    this.collect();
  }

  private hasReview(id: string): boolean {
    // The shared catalog loads after the local store during host startup.
    if (id.startsWith("shared-") && !this.external) return true;

    return this.store.has(id) || Boolean(this.external?.has(id));
  }

  private assertReview(id: string) {
    if (!this.hasReview(id))
      throw new ReviewInputError("Review not found.", 404);
  }

  async remove(reviewId: string) {
    await Promise.all(this.requests.values());
    this.collect(undefined, reviewId);
    await this.cleanup;

    if (this.all().some((item) => item.reviewId === reviewId))
      throw new ReviewInputError(
        "Could not remove the managed workspace. Retry deletion.",
        409,
      );
  }

  private all(): Environment[] {
    return this.db
      .prepare("SELECT value FROM pinned_environments")
      .all()
      .map((row) => JSON.parse(String(row.value)));
  }

  private get(id: string): Environment | undefined {
    const row = this.db
      .prepare("SELECT value FROM pinned_environments WHERE id=?")
      .get(id);

    return row ? JSON.parse(String(row.value)) : undefined;
  }

  private save(environment: Environment) {
    this.db
      .prepare(
        "INSERT INTO pinned_environments VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(environment.id, JSON.stringify(environment));
  }

  private status(environment: Environment): WorkspaceStatus {
    const { id, commit, rootPath, generation, state, log } = environment;

    const status: WorkspaceStatus = {
      id,
      commit,
      rootPath,
      generation,
      state,
      log,
    };

    if (state === "failed" && !rootPath) status.issue = log;

    return status;
  }

  list(reviewId: string): WorkspaceStatus[] {
    return this.all()
      .filter((item) => item.reviewId === reviewId)
      .map((item) => this.status(item));
  }

  failures(): WorkspaceStatus[] {
    return this.all()
      .filter((item) => item.state === "cleanup-failed")
      .map((item) => this.status(item));
  }

  async retryCleanup(id: string) {
    const environment = this.get(id);

    if (!environment || environment.state !== "cleanup-failed")
      throw new ReviewInputError("Cleanup failure not found.", 404);
    this.collect(id);
    await this.cleanup;
  }

  async open(reviewId: string, pins: Pins): Promise<void> {
    await this.source(reviewId, pins, "head");

    if (pins.base !== pins.head) await this.source(reviewId, pins, "base");
  }

  source(
    reviewId: string,
    pins: Pins,
    side: "base" | "head",
    retryFailed = false,
  ): Promise<WorkspaceStatus> {
    if (this.closed)
      return Promise.reject(new Error("Language environments are closed."));
    this.assertReview(reviewId);

    const id = createHash("sha256")
      .update(JSON.stringify([reviewId, pins.repositoryId, pins[side]]))
      .digest("hex");

    const current = this.requests.get(id);

    if (current) return current;

    const request = this.acquire(id, reviewId, pins, side, retryFailed).finally(
      () => this.requests.delete(id),
    );

    this.requests.set(id, request);

    return request;
  }

  private async acquire(
    id: string,
    reviewId: string,
    pins: Pins,
    side: "base" | "head",
    retryFailed: boolean,
  ): Promise<WorkspaceStatus> {
    let environment = this.get(id);

    if (this.jobs.has(id)) return this.status(environment!);
    environment ??= {
      id,
      reviewId,
      repositoryId: pins.repositoryId,
      repository: "",
      commit: pins[side],
      rootPath: null,
      generation: randomUUID(),
      commandsHash: "",
      role: pins.base === pins.head ? "head" : side,
      state: "pending",
      log: "",
    };
    this.save(environment);

    try {
      const root = this.store.repositoryPath(pins.repositoryId);

      const repository =
        environment.repository || (await gitCommonDir(root).catch(() => null));

      if (!repository)
        throw new Error(
          "Repository Git directory is unavailable. Restore the registered checkout and retry preparation.",
        );
      environment.repository = repository;

      const result = await git(
        repository,
        ["config", "--null", "--get-all", "devfast.prepare"],
        { allowFailure: true },
      );

      const commands = result.stdout.trim()
        ? result.stdout.split("\0").filter((command) => command.trim())
        : [];

      const commandsHash = reviewPrepareCommandsHash(commands);

      const existed =
        environment.rootPath &&
        existsSync(path.join(environment.rootPath, ".git"));

      const checkout = await ensureReviewPinnedCheckout({
        rootPath: existsSync(root) ? root : repository,
        reviewUuid: reviewId,
        ref: pins[side],
        role: environment.role,
      });

      if (!checkout) throw new Error("Pinned checkout is unavailable.");

      if (!this.hasReview(reviewId)) {
        environment.rootPath = checkout;
        this.save(environment);
        this.collect();

        return this.status(environment);
      }

      const changed =
        !existed ||
        environment.rootPath !== checkout ||
        environment.commandsHash !== commandsHash;

      environment.rootPath = checkout;
      environment.commandsHash = commandsHash;

      if (!commands.length) {
        environment.state = "unconfigured";
        environment.log =
          "Configure dependencies with git config devfast.prepare '<command>'.";
      } else if (
        await markerMatches(reviewPrepareMarkerPath(checkout), commandsHash)
      ) {
        environment.state = "ready";
        environment.log = "";
      } else if (environment.state !== "failed" || changed || retryFailed) {
        environment.state = "preparing";
        environment.generation = randomUUID();
        environment.log = "Preparing pinned checkout…";
        this.save(environment);
        this.prepare(environment, commands);

        return this.status(environment);
      }

      if (changed) environment.generation = randomUUID();
    } catch (error) {
      environment.state = "failed";
      environment.rootPath = null;
      environment.log = errorMessage(error);
    }

    this.save(environment);

    return this.status(environment);
  }

  private prepare(environment: Environment, commands: string[]) {
    const abort = new AbortController();

    const done = prepareReviewPinnedCheckout({
      checkoutPath: environment.rootPath!,
      commit: environment.commit,
      commands,
      signal: abort.signal,
      progress: (log) => {
        environment.log = log;
        this.save(environment);
      },
      warning: (log) => {
        environment.log = log;
      },
    })
      .then(async (result) => {
        environment.state = result.prepared ? "ready" : "failed";

        if (!result.prepared)
          environment.log = await readFile(
            reviewPrepareLogPath(environment.rootPath!),
            "utf8",
          ).catch(() => environment.log);
      })
      .catch((error) => {
        environment.state = "failed";
        environment.log = errorMessage(error);
      })
      .finally(() => {
        environment.generation = randomUUID();
        this.save(environment);
        this.jobs.delete(environment.id);
      });

    this.jobs.set(environment.id, { done, abort });
  }

  async retry(reviewId: string, id: string): Promise<WorkspaceStatus> {
    const environment = this.get(id);

    if (!environment || environment.reviewId !== reviewId)
      throw new ReviewInputError("Language environment not found.", 404);

    if (this.jobs.has(id)) return this.status(environment);

    if (environment.state === "cleanup-failed") {
      this.collect();

      return this.status(environment);
    }

    this.assertReview(reviewId);

    if (environment.rootPath)
      await rm(reviewPrepareMarkerPath(environment.rootPath), { force: true });
    environment.state = "pending";
    environment.generation = randomUUID();
    this.save(environment);

    return this.source(
      reviewId,
      {
        repositoryId: environment.repositoryId,
        base: environment.commit,
        head: environment.commit,
      },
      "head",
    );
  }

  private collect(retryId?: string, removedReviewId?: string) {
    // Capture ownership before awaiting, so shutdown never reads a closed store.
    const deleted = this.all().filter(
      (environment) =>
        (environment.reviewId === removedReviewId ||
          !this.hasReview(environment.reviewId)) &&
        (environment.state !== "cleanup-failed" ||
          environment.id === retryId ||
          environment.reviewId === removedReviewId),
    );

    this.cleanup = this.cleanup.then(async () => {
      for (const environment of deleted) {
        const job = this.jobs.get(environment.id);
        job?.abort.abort();
        await job?.done;

        try {
          if (environment.rootPath && existsSync(environment.rootPath)) {
            const managed = reviewManagedCheckoutRoot(
              environment.repository,
              environment.reviewId,
            );

            const relative = path.relative(managed, environment.rootPath);

            if (
              !relative ||
              relative.startsWith("..") ||
              path.isAbsolute(relative)
            )
              throw new Error("Refusing to remove a non-managed checkout.");
            await git(environment.repository, [
              "worktree",
              "remove",
              "--force",
              environment.rootPath,
            ]);
          }

          if (environment.rootPath)
            await removeReviewPrepareArtifacts(environment.rootPath);

          this.db
            .prepare("DELETE FROM pinned_environments WHERE id=?")
            .run(environment.id);
        } catch (error) {
          environment.state = "cleanup-failed";
          environment.log = errorMessage(error);
          this.save(environment);
        }
      }
    });
  }

  async idle() {
    await Promise.all(this.requests.values());
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    await this.cleanup;
  }

  private closing?: Promise<void>;

  close(): Promise<void> {
    return (this.closing ??= this.closeAll());
  }

  private async closeAll() {
    this.closed = true;
    this.stop();
    this.stopExternal?.();
    await Promise.all(this.requests.values());

    for (const job of this.jobs.values()) job.abort.abort();
    await this.idle();
    this.db
      .prepare("DELETE FROM workspace_owner WHERE owner=?")
      .run(this.ownerId);
    this.db.close();
  }
}
