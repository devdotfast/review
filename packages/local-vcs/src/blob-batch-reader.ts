// One `git cat-file --batch` per object store; this module owns the process lifecycle and framing.
import type { ChildProcessByStdio } from "node:child_process";
import type { Socket } from "node:net";

import { spawnObserved } from "./exec";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;

const headerPattern = /^[0-9a-f]+ ([a-z]+) (\d+)$/;

const KILL_TIMEOUT_MS = 2_000;

const newline = 0x0a;

export interface BlobBatchReaderInput {
  objectStoreArgs: () => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  idleTimeoutMs?: number;
  maxBlobBytes?: number;
}

export type BlobBatchAnswer =
  | { found: "blob"; blob: Buffer }
  | { found: "other" }
  | { found: "nothing" };

const NOTHING: BlobBatchAnswer = { found: "nothing" };

interface PendingRead {
  resolve(value: BlobBatchAnswer): void;
  reject(reason: Error): void;
}

interface BatchSession {
  child: ChildProcessByStdio<Socket, Socket, null>;
  pending: PendingRead[];
  buffered: Buffer;
  expected: number | null;
  collected: Buffer[] | null;
  writes: Promise<void>;
  tail: Promise<unknown>;
  exit: Promise<void>;
}

/** Not a cache: every read reaches git. Starts on first read, retires when idle, respawns after a crash. */
export class BlobBatchReader {
  private session: BatchSession | null = null;

  private objectStoreArgs: string[] | null = null;

  private starting: Promise<BatchSession | null> | null = null;

  private idleTimer: NodeJS.Timeout | null = null;

  private closed = false;

  constructor(private readonly input: BlobBatchReaderInput) {}

  get pid(): number | undefined {
    return this.session?.child.pid;
  }

  processExit(): Promise<void> {
    return this.session?.exit ?? Promise.resolve();
  }

  async read(commit: string, relativePath: string): Promise<Buffer | null> {
    const answer = await this.readObject(commit, relativePath);

    return answer.found === "blob" ? answer.blob : null;
  }

  async readObject(
    commit: string,
    relativePath: string,
  ): Promise<BlobBatchAnswer> {
    const request = `${commit}:${relativePath}`;

    if (this.closed || request.includes("\n")) return NOTHING;

    const session = await this.start();

    if (!session) return NOTHING;

    const answer = new Promise<BlobBatchAnswer>((resolve, reject) => {
      session.pending.push({ resolve, reject });
      session.writes = session.writes.then(() =>
        this.write(session, `${request}\n`),
      );
    });

    session.tail = answer.catch(() => null);
    this.holdEventLoop(session);
    this.armIdleTimer(session);

    return answer;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    await this.starting?.catch(() => null);
    const session = this.session;

    if (!session) return;

    await session.writes.catch(() => null);
    await session.tail;

    // Re-ref so a host awaiting this close cannot exit before the process is gone.
    this.setEventLoopHold(session, true);
    this.retire(session);
    await this.awaitExit(session);
  }

  private async awaitExit(session: BatchSession): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), KILL_TIMEOUT_MS);
      timer.unref();
    });

    const outcome = await Promise.race([
      session.exit.then(() => "exited" as const),
      expired,
    ]);

    clearTimeout(timer);

    if (outcome === "exited") return;
    session.child.kill("SIGKILL");
    await session.exit;
  }

  private start(): Promise<BatchSession | null> {
    if (this.session) return Promise.resolve(this.session);

    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private async spawn(): Promise<BatchSession | null> {
    const args =
      this.objectStoreArgs ??
      (await this.input.objectStoreArgs().catch(() => null));

    if (!args) return null;
    this.objectStoreArgs = args;

    const child = spawnObserved("git", [...args, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: this.input.env,
    });

    const session: BatchSession = {
      child,
      pending: [],
      buffered: Buffer.alloc(0),
      expected: null,
      collected: null,
      writes: Promise.resolve(),
      tail: Promise.resolve(),
      exit: new Promise((resolve) => {
        child.once("close", () => resolve());
      }),
    };

    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => this.consume(session, chunk));
    child.once("error", (cause: Error) =>
      this.fail(session, "git cat-file --batch could not start.", cause),
    );
    child.once("exit", () =>
      this.fail(session, "git cat-file --batch stopped before answering."),
    );
    this.session = session;
    this.armIdleTimer(session);

    return session;
  }

  private consume(session: BatchSession, chunk: Buffer): void {
    session.buffered =
      session.buffered.length > 0
        ? Buffer.concat([session.buffered, chunk])
        : chunk;

    for (;;) {
      if (session.expected === null) {
        const end = session.buffered.indexOf(newline);

        if (end < 0) break;
        const header = session.buffered.subarray(0, end).toString("utf8");

        session.buffered = session.buffered.subarray(end + 1);
        const answer = headerPattern.exec(header);

        if (!answer) {
          this.settle(session, NOTHING);
          continue;
        }

        const size = Number(answer[2]);

        session.expected = size + 1;
        session.collected =
          answer[1] === "blob" && size <= this.maxBlobBytes ? [] : null;
      }

      const take = Math.min(session.buffered.length, session.expected);

      session.collected?.push(session.buffered.subarray(0, take));
      session.buffered = session.buffered.subarray(take);
      session.expected -= take;

      if (session.expected > 0) break;
      const collected = session.collected;

      session.expected = null;
      session.collected = null;
      this.settle(
        session,
        collected
          ? // The framing newline is the last of the collected bytes.
            { found: "blob", blob: Buffer.concat(collected).subarray(0, -1) }
          : { found: "other" },
      );
    }

    this.armIdleTimer(session);
  }

  private settle(session: BatchSession, value: BlobBatchAnswer): void {
    session.pending.shift()?.resolve(value);
    this.holdEventLoop(session);
  }

  /** Hold the loop only while a read is pending or a close is in progress. */
  private holdEventLoop(session: BatchSession): void {
    this.setEventLoopHold(session, session.pending.length > 0 || this.closed);
  }

  private setEventLoopHold(session: BatchSession, hold: boolean): void {
    for (const handle of [
      session.child,
      session.child.stdin,
      session.child.stdout,
    ]) {
      if (hold) handle.ref();
      else handle.unref();
    }
  }

  private fail(session: BatchSession, message: string, cause?: Error): void {
    if (this.session === session) {
      this.session = null;
      this.clearIdleTimer();
    }

    for (const read of session.pending.splice(0)) {
      read.reject(cause ? new Error(message, { cause }) : new Error(message));
    }

    this.holdEventLoop(session);
  }

  private write(session: BatchSession, request: string): Promise<void> {
    const stdin = session.child.stdin;

    // Closed pipe: the child's exit rejects the queued read.
    if (!stdin.writable) return Promise.resolve();

    return new Promise((resolve) => {
      if (stdin.write(request)) {
        resolve();

        return;
      }

      const proceed = () => {
        stdin.off("drain", proceed);
        resolve();
      };

      stdin.once("drain", proceed);
      void session.exit.then(proceed);
    });
  }

  private get maxBlobBytes(): number {
    return this.input.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  }

  private armIdleTimer(session: BatchSession): void {
    if (this.session !== session) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      if (session.pending.length > 0) {
        this.armIdleTimer(session);

        return;
      }

      this.retire(session);
    }, this.input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Null the session before killing so its exit rejects nothing. */
  private retire(session: BatchSession): void {
    if (this.session === session) {
      this.session = null;
      this.clearIdleTimer();
    }

    session.child.kill();
  }
}
