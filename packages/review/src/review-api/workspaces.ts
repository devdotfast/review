import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { git, gitCommonDir } from "@dev.fast/local-vcs";

import { reviewManagedCheckoutRoot } from "../review-checkout-paths.js";
import { ensureReviewPinnedCheckout } from "../review-head-checkout.js";
import {
  markerMatches,
  prepareReviewPinnedCheckout,
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

  constructor(
    databasePath: string,
    private readonly store: ReviewStore,
  ) {
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS pinned_environments(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );

    // A new host must invalidate models and recheck preparation markers on access.
    for (const environment of this.all()) {
      if (environment.state === "preparing") environment.state = "pending";
      environment.generation = randomUUID();
      this.save(environment);
    }

    this.stop = store.subscribeCatalog(() => this.collect());
    this.collect();
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

    return { id, commit, rootPath, generation, state, log };
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

  retryCleanup(id: string) {
    const environment = this.get(id);

    if (!environment || environment.state !== "cleanup-failed")
      throw new ReviewInputError("Cleanup failure not found.", 404);
    this.collect(id);
  }

  async open(reviewId: string, pins: Pins): Promise<void> {
    await this.source(reviewId, pins, "head");

    if (pins.base !== pins.head) await this.source(reviewId, pins, "base");
  }

  source(
    reviewId: string,
    pins: Pins,
    side: "base" | "head",
  ): Promise<WorkspaceStatus> {
    if (this.closed)
      return Promise.reject(new Error("Language environments are closed."));
    this.store.assertExists(reviewId);

    const id = createHash("sha256")
      .update(JSON.stringify([reviewId, pins.repositoryId, pins[side]]))
      .digest("hex");

    const current = this.requests.get(id);

    if (current) return current;

    const request = this.acquire(id, reviewId, pins, side).finally(() =>
      this.requests.delete(id),
    );

    this.requests.set(id, request);

    return request;
  }

  private async acquire(
    id: string,
    reviewId: string,
    pins: Pins,
    side: "base" | "head",
  ): Promise<WorkspaceStatus> {
    let environment = this.get(id);

    if (this.jobs.has(id)) return this.status(environment!);
    const root = this.store.repositoryPath(pins.repositoryId);
    const repository = environment?.repository ?? (await gitCommonDir(root));

    if (!repository)
      throw new ReviewInputError(
        "Repository Git directory is unavailable.",
        409,
      );
    environment ??= {
      id,
      reviewId,
      repositoryId: pins.repositoryId,
      repository,
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

      if (!this.store.has(reviewId)) {
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
      } else if (environment.state !== "failed" || changed) {
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
      environment.log = String(error);
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
        environment.log = String(error);
      })
      .finally(() => {
        environment.generation = randomUUID();
        this.save(environment);
        this.jobs.delete(environment.id);
      });

    this.jobs.set(environment.id, { done, abort });
  }

  async retry(reviewId: string, id: string): Promise<void> {
    const environment = this.get(id);

    if (!environment || environment.reviewId !== reviewId)
      throw new ReviewInputError("Language environment not found.", 404);

    if (this.jobs.has(id)) return;

    if (environment.state === "cleanup-failed") {
      this.collect();

      return;
    }

    this.store.assertExists(reviewId);

    if (environment.rootPath)
      await rm(reviewPrepareMarkerPath(environment.rootPath), { force: true });
    environment.state = "pending";
    environment.generation = randomUUID();
    this.save(environment);
    await this.source(
      reviewId,
      {
        repositoryId: environment.repositoryId,
        base: environment.commit,
        head: environment.commit,
      },
      "head",
    );
  }

  private collect(retryId?: string) {
    // Capture ownership before awaiting, so shutdown never reads a closed store.
    const deleted = this.all().filter(
      (environment) =>
        !this.store.has(environment.reviewId) &&
        (environment.state !== "cleanup-failed" || environment.id === retryId),
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

          if (environment.rootPath) {
            await rm(reviewPrepareMarkerPath(environment.rootPath), {
              force: true,
            });
            await rm(reviewPrepareLogPath(environment.rootPath), {
              force: true,
            });
          }

          this.db
            .prepare("DELETE FROM pinned_environments WHERE id=?")
            .run(environment.id);
        } catch (error) {
          environment.state = "cleanup-failed";
          environment.log = String(error);
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
    await Promise.all(this.requests.values());

    for (const job of this.jobs.values()) job.abort.abort();
    await this.idle();
    this.db.close();
  }
}
