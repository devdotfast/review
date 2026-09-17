import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { git, gitCommonDir } from "@dev.fast/local-vcs";
import { z } from "zod";

import { ReviewInputError } from "./document.js";
import type { Pins } from "./document.js";
import type { ReviewStore } from "./store.js";

export const workspaceSettingsSchema = z.strictObject({
  setup: z.string().max(64_000),
  teardown: z.string().max(64_000),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export interface WorkspaceStatus {
  id: string;
  commit: string;
  directory: string;
  state:
    | "pending"
    | "preparing"
    | "ready"
    | "unconfigured"
    | "failed"
    | "cleanup-failed";
  log: string;
}

interface Workspace extends WorkspaceStatus {
  repository: string;
  setup: string;
  teardown: string;
}

/** Local settings and disposable environments, separate from authored snapshots.
 * A single desktop host owns this queue. Ownership is persisted before subprocesses
 * start, and reconciled from every historical version after a restart.
 */
export class ReviewWorkspaces {
  private readonly db: DatabaseSync;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly stop: () => void;
  private readonly root: string;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();

  constructor(
    databasePath: string,
    private readonly store: ReviewStore,
  ) {
    this.root = path.join(path.dirname(databasePath), "workspaces");
    this.db = new DatabaseSync(`${databasePath}.workspaces`, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(repository TEXT PRIMARY KEY, setup TEXT NOT NULL, teardown TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS environments(id TEXT PRIMARY KEY, repository TEXT NOT NULL, commit_id TEXT NOT NULL,
        directory TEXT NOT NULL, setup TEXT NOT NULL, teardown TEXT NOT NULL, state TEXT NOT NULL, log TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owners(review_id TEXT NOT NULL, repository_id TEXT NOT NULL, commit_id TEXT NOT NULL,
        environment_id TEXT NOT NULL, PRIMARY KEY(review_id,repository_id,commit_id));
      CREATE TABLE IF NOT EXISTS preparation_errors(review_id TEXT PRIMARY KEY, log TEXT NOT NULL);`);
    this.db.exec(
      "UPDATE environments SET state='pending' WHERE state='preparing'",
    );
    this.stop = store.subscribe(() => this.reconcile());
    this.reconcile();
  }

  private enqueue(run: () => Promise<void>) {
    if (this.closed) return;
    this.pending = this.pending.then(run).catch((error) => {
      // Keep background failures inspectable without rejecting review authoring.
      this.db
        .prepare(
          "UPDATE environments SET state='failed',log=? WHERE state IN ('pending','preparing')",
        )
        .run(String(error));
    });
  }

  async idle() {
    await this.pending;
    await Promise.all(this.jobs.values());
  }
  async close() {
    if (this.closed) return;
    this.stop();
    this.closed = true;
    this.shutdown.abort();
    await this.idle();
    this.db.close();
  }

  private async repository(repositoryId: string) {
    const root = this.store.repositoryPath(repositoryId);
    const common = await gitCommonDir(root);

    if (!common)
      throw new ReviewInputError("Repository Git directory is unavailable.");

    return realpath(common);
  }

  async settings(repositoryId: string): Promise<WorkspaceSettings> {
    return this.settingsAt(await this.repository(repositoryId));
  }
  private settingsAt(repository: string): WorkspaceSettings {
    const row = this.db
      .prepare("SELECT setup,teardown FROM settings WHERE repository=?")
      .get(repository);

    return {
      setup: String(row?.setup ?? ""),
      teardown: String(row?.teardown ?? ""),
    };
  }
  async configure(repositoryId: string, settings: WorkspaceSettings) {
    const repository = await this.repository(repositoryId);
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?,?) ON CONFLICT(repository) DO UPDATE SET setup=excluded.setup,teardown=excluded.teardown",
      )
      .run(repository, settings.setup, settings.teardown);

    return settings;
  }

  reconcile() {
    // Capture before deletion loses the review's pins; queued reconciliations
    // preserve command order even while dependency installation is running.
    const inputs = this.store.workspacePins();
    this.enqueue(async () => {
      const reviews = new Set(inputs.map((input) => input.reviewId));

      for (const row of this.db
        .prepare("SELECT DISTINCT review_id FROM owners")
        .all()) {
        if (!reviews.has(String(row.review_id)))
          this.db
            .prepare("DELETE FROM owners WHERE review_id=?")
            .run(row.review_id!);
      }

      const failed = new Set<string>();

      for (const { reviewId, pins } of inputs) {
        try {
          for (const commit of new Set([pins.base, pins.head])) {
            await this.acquire(reviewId, pins.repositoryId, commit);
          }
        } catch (error) {
          failed.add(reviewId);
          this.db
            .prepare(
              "INSERT INTO preparation_errors VALUES(?,?) ON CONFLICT(review_id) DO UPDATE SET log=excluded.log",
            )
            .run(reviewId, String(error));
        }
      }

      for (const row of this.db
        .prepare("SELECT review_id FROM preparation_errors")
        .all()) {
        if (!failed.has(String(row.review_id)))
          this.db
            .prepare("DELETE FROM preparation_errors WHERE review_id=?")
            .run(row.review_id!);
      }

      await this.cleanup();
    });
  }

  private read(id: string): Workspace {
    const row = this.db
      .prepare("SELECT * FROM environments WHERE id=?")
      .get(id);

    if (!row) throw new ReviewInputError("Workspace does not exist.", 404);

    return {
      id: String(row.id),
      repository: String(row.repository),
      commit: String(row.commit_id),
      directory: String(row.directory),
      setup: String(row.setup),
      teardown: String(row.teardown),
      state: z
        .enum([
          "pending",
          "preparing",
          "ready",
          "unconfigured",
          "failed",
          "cleanup-failed",
        ])
        .parse(row.state),
      log: String(row.log),
    };
  }
  private owned(reviewId: string, repositoryId: string, commit: string) {
    const row = this.db
      .prepare(
        "SELECT environment_id FROM owners WHERE review_id=? AND repository_id=? AND commit_id=?",
      )
      .get(reviewId, repositoryId, commit);

    return row ? this.read(String(row.environment_id)) : undefined;
  }
  private async acquire(
    reviewId: string,
    repositoryId: string,
    commit: string,
  ) {
    if (!this.store.has(reviewId)) return;
    const owned = this.owned(reviewId, repositoryId, commit);

    if (owned) {
      if (
        owned.state === "pending" ||
        !existsSync(path.join(owned.directory, ".git"))
      )
        await this.prepare(owned);

      return;
    }

    const repository = await this.repository(repositoryId);
    const settings = this.settingsAt(repository);

    const id = createHash("sha256")
      .update(JSON.stringify([repository, commit, settings]))
      .digest("hex");

    const directory = path.join(this.root, id);
    this.db
      .prepare("INSERT OR IGNORE INTO environments VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        repository,
        commit,
        directory,
        settings.setup,
        settings.teardown,
        "pending",
        "",
      );
    this.db
      .prepare("INSERT INTO owners VALUES(?,?,?,?)")
      .run(reviewId, repositoryId, commit, id);
    const environment = this.read(id);

    if (
      environment.state === "pending" ||
      !existsSync(path.join(directory, ".git"))
    )
      await this.prepare(environment);
  }

  private state(id: string, state: WorkspaceStatus["state"], log: string) {
    this.db
      .prepare("UPDATE environments SET state=?,log=? WHERE id=?")
      .run(state, log.slice(-64_000), id);
  }
  private async prepare(environment: Workspace) {
    if (this.jobs.has(environment.id)) return;
    this.state(environment.id, "preparing", "");

    try {
      if (!existsSync(path.join(environment.directory, ".git"))) {
        await mkdir(this.root, { recursive: true });
        await git(environment.repository, ["worktree", "prune"]);
        await git(environment.repository, [
          "worktree",
          "add",
          "--detach",
          environment.directory,
          environment.commit,
        ]);
      }

      if (!environment.setup.trim()) {
        this.state(
          environment.id,
          "unconfigured",
          "Configure project setup to install dependencies for language features.",
        );

        return;
      }

      const job = runHook(
        environment.setup,
        environment.directory,
        (log) => this.state(environment.id, "preparing", log),
        this.shutdown.signal,
      )
        .then(
          (log) => this.state(environment.id, "ready", log),
          (error) => this.state(environment.id, "failed", String(error)),
        )
        .finally(() => {
          this.jobs.delete(environment.id);
        });

      this.jobs.set(environment.id, job);
    } catch (error) {
      this.state(environment.id, "failed", String(error));
    }
  }

  status(reviewId: string, pins: Pins) {
    const rows = [...new Set([pins.base, pins.head])].flatMap((commit) => {
      const environment = this.owned(reviewId, pins.repositoryId, commit);

      return environment ? [this.publicStatus(environment)] : [];
    });

    const failure = this.db
      .prepare("SELECT log FROM preparation_errors WHERE review_id=?")
      .get(reviewId);

    if (failure)
      rows.push({
        id: `review:${reviewId}`,
        commit: pins.head,
        directory: "",
        state: "failed",
        log: String(failure.log),
      });

    return rows;
  }
  private publicStatus({
    id,
    commit,
    directory,
    state,
    log,
  }: Workspace): WorkspaceStatus {
    return { id, commit, directory, state, log };
  }
  failures() {
    return this.db
      .prepare("SELECT id FROM environments WHERE state='cleanup-failed'")
      .all()
      .map((row) => this.publicStatus(this.read(String(row.id))));
  }
  async source(reviewId: string, pins: Pins, side: "base" | "head") {
    this.enqueue(() => this.acquire(reviewId, pins.repositoryId, pins[side]));
    await this.pending;
    const environment = this.owned(reviewId, pins.repositoryId, pins[side]);

    if (!environment || !existsSync(path.join(environment.directory, ".git")))
      throw new ReviewInputError(
        "Pinned workspace is unavailable. Retry project setup.",
        409,
      );

    return this.publicStatus(environment);
  }
  retry(id: string) {
    if (id.startsWith("review:")) {
      this.store.assertExists(id.slice("review:".length));
      this.reconcile();

      return;
    }

    this.read(id);
    this.enqueue(async () => {
      const environment = this.read(id);

      if (environment.state === "cleanup-failed") {
        const owned = this.db
          .prepare("SELECT 1 FROM owners WHERE environment_id=?")
          .get(id);

        if (!owned) await this.cleanup(id);
        else if (await this.remove(environment)) {
          this.db.prepare("DELETE FROM owners WHERE environment_id=?").run(id);
          this.db.prepare("DELETE FROM environments WHERE id=?").run(id);
        }
      } else await this.prepare(environment);
    });
    this.reconcile();
  }
  async rebuild(repositoryId: string) {
    const repository = await this.repository(repositoryId);
    this.enqueue(async () => {
      // Explicit rebuilding changes every owner together, including historical versions.
      for (const row of this.db
        .prepare("SELECT id FROM environments WHERE repository=?")
        .all(repository)) {
        const environment = this.read(String(row.id));

        if (!(await this.remove(environment))) continue;
        this.db
          .prepare("DELETE FROM owners WHERE environment_id=?")
          .run(environment.id);
        this.db
          .prepare("DELETE FROM environments WHERE id=?")
          .run(environment.id);
      }
    });
    this.reconcile();
  }
  private async remove(environment: Workspace) {
    await this.jobs.get(environment.id);

    try {
      if (!environment.teardown.trim() && !existsSync(environment.directory)) {
        await git(environment.repository, ["worktree", "prune"]);

        return true;
      }

      if (environment.teardown.trim())
        await runHook(
          environment.teardown,
          environment.directory,
          (log) => this.state(environment.id, "cleanup-failed", log),
          this.shutdown.signal,
        );
      await git(environment.repository, [
        "worktree",
        "remove",
        "--force",
        environment.directory,
      ]);

      return true;
    } catch (error) {
      this.state(environment.id, "cleanup-failed", String(error));

      return false;
    }
  }
  private async cleanup(only?: string) {
    const unused = this.db
      .prepare(
        "SELECT id FROM environments WHERE id NOT IN (SELECT environment_id FROM owners)",
      )
      .all();

    for (const row of unused) {
      const environment = this.read(String(row.id));

      if (
        only ? environment.id !== only : environment.state === "cleanup-failed"
      )
        continue;

      if (await this.remove(environment))
        this.db
          .prepare("DELETE FROM environments WHERE id=?")
          .run(environment.id);
    }
  }
}

function runHook(
  command: string,
  cwd: string,
  progress: (log: string) => void,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let output = "";

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let interrupted: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may already have exited. */
      }
    };

    const stop = (reason: Error) => {
      interrupted = reason;
      kill("SIGTERM");
      force ??= setTimeout(() => kill("SIGKILL"), 2000);
      force.unref();
    };

    const abort = () =>
      stop(new Error("Project command interrupted by shutdown."));

    signal.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(
      () => stop(new Error("Project command timed out after 15 minutes.")),
      15 * 60_000,
    );

    timeout.unref();

    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64_000);
      progress(output);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", abort);

      if (interrupted) reject(new Error(`${interrupted.message}\n${output}`));
      else if (code === 0) resolve(output);
      else reject(new Error(`Command exited with ${code}.\n${output}`));
    });
  });
}
