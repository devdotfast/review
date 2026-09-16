// One `git cat-file --batch` process per object store answers every pinned
// read for that repository, so a read costs a pipe round trip instead of a
// process. This module owns only the process lifecycle and the batch framing;
// where the object store lives is the caller's business.
import type { ChildProcessByStdio } from "node:child_process";
import type { Socket } from "node:net";

import { spawnObserved } from "./exec";

/** Inactivity after which the batch process is retired. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** The largest answer collected, matching the old per-read `maxBuffer`. */
const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;

/** `<oid> <type> <size>`; anything else (`<object> missing`) has no body. */
const headerPattern = /^[0-9a-f]+ ([a-z]+) (\d+)$/;

/** How long a closing process has to leave on SIGTERM before SIGKILL. */
const KILL_TIMEOUT_MS = 2_000;

const newline = 0x0a;

export interface BlobBatchReaderInput {
  /** git argv locating the object store, resolved once before the first spawn. */
  objectStoreArgs: () => Promise<string[]>;
  /** Environment for the git process. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  idleTimeoutMs?: number;
  maxBlobBytes?: number;
}

/**
 * What a read found: the blob, an object that is not one (a directory's tree,
 * or a blob too large to hold), or nothing at that path.
 */
export type BlobBatchAnswer =
  | { found: "blob"; blob: Buffer }
  | { found: "other" }
  | { found: "nothing" };

const NOTHING: BlobBatchAnswer = { found: "nothing" };

interface PendingRead {
  resolve(value: BlobBatchAnswer): void;
  reject(reason: Error): void;
}

/** One batch process with its request queue and its parser position. */
interface BatchSession {
  child: ChildProcessByStdio<Socket, Socket, null>;
  /** Readers waiting, in the order git will answer them. */
  pending: PendingRead[];
  /** Stdout bytes not yet framed into an answer. */
  buffered: Buffer;
  /** Framed bytes still to consume for the current answer, body plus newline. */
  expected: number | null;
  /** The current answer's bytes, or null while its body is being discarded. */
  collected: Buffer[] | null;
  /** Serializes writes, so requests reach git in the order they were queued. */
  writes: Promise<void>;
  /** The last queued read, so a close can wait for the queue to drain. */
  tail: Promise<unknown>;
  exit: Promise<void>;
}

/**
 * Reads blobs at resolved commit ids from one git object store. The process
 * starts on the first read, is retired when idle, and is replaced on the next
 * read after a crash. Not a cache: every read reaches git.
 */
export class BlobBatchReader {
  private session: BatchSession | null = null;

  /** The resolved object-store argv, kept across a respawn. */
  private objectStoreArgs: string[] | null = null;

  private starting: Promise<BatchSession | null> | null = null;

  private idleTimer: NodeJS.Timeout | null = null;

  private closed = false;

  constructor(private readonly input: BlobBatchReaderInput) {}

  /** The batch process's id while one is running. */
  get pid(): number | undefined {
    return this.session?.child.pid;
  }

  /** Resolves when the process running now has exited, at once if none is. */
  processExit(): Promise<void> {
    return this.session?.exit ?? Promise.resolve();
  }

  /**
   * The blob at `commit:relativePath`, or null when there is none to read: a
   * missing path, an unknown commit, a directory, or an answer too large to
   * hold in memory. `readObject` tells those apart.
   */
  async read(commit: string, relativePath: string): Promise<Buffer | null> {
    const answer = await this.readObject(commit, relativePath);

    return answer.found === "blob" ? answer.blob : null;
  }

  /** What the object store holds at `commit:relativePath`. */
  async readObject(
    commit: string,
    relativePath: string,
  ): Promise<BlobBatchAnswer> {
    const request = `${commit}:${relativePath}`;

    // A request line is newline framed, so a newline in it cannot be asked.
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

  /** Finish the queued reads, then stop the process. Reads after this are null. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    await this.starting?.catch(() => null);
    const session = this.session;

    if (!session) return;

    await session.writes.catch(() => null);
    await session.tail;

    /* The last answer unref'd the process, so hold the loop again: a host
       awaiting this close must not exit before the process is gone. */
    this.setEventLoopHold(session, true);
    this.retire(session);
    await this.awaitExit(session);
  }

  /** Wait out the terminated process, escalating if it ignores the signal. */
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

    // Cold callers share one spawn.
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

    // A broken pipe is reported by the exit that follows it.
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

  /** Frame answers out of stdout: a header line, then its body and newline. */
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
          // `<object> missing`, and any other bodiless answer.
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

  /**
   * Hold the event loop only while a read is waiting. An idle batch process
   * must not keep a short-lived host alive, and a waiting one must not let it
   * exit before the answer arrives.
   */
  private holdEventLoop(session: BatchSession): void {
    /* While closing, the hold stays on even with nothing pending: the exit
       this close awaits arrives on a later loop turn than the process's own
       exit event, which is what empties the queue. */
    this.setEventLoopHold(session, session.pending.length > 0 || this.closed);
  }

  /** The pipes hold the loop as the process does, so all three move together. */
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

    /* A closed pipe means the process is gone, so the read this request would
       have carried is rejected by the child's close, not by this write. */
    if (!stdin.writable) return Promise.resolve();

    return new Promise((resolve) => {
      if (stdin.write(request)) {
        resolve();

        return;
      }

      // Backpressure: the next request waits for the pipe, or for the exit.
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

  /** Drop the session before killing it, so its exit rejects nothing. */
  private retire(session: BatchSession): void {
    if (this.session === session) {
      this.session = null;
      this.clearIdleTimer();
    }

    session.child.kill();
  }
}
