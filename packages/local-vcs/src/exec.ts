// Every git/jj subprocess this package spawns goes through these three
// wrappers so a host (the Review CLI's startup tracer) can observe each spawn
// without this package depending on any tracing library. Without an observer
// they are plain `execFile` / `execFileSync` / `spawn`.
import {
  type ChildProcessByStdio,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type SpawnOptionsWithStdioTuple,
  type StdioPipe,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import type { Socket } from "node:net";
import { promisify } from "node:util";

export interface LocalVcsCommandObserver {
  /** Called before the process spawns. Returns a completion callback. */
  start(input: {
    file: string;
    args: string[];
    cwd: string | undefined;
  }): (outcome: { ok: boolean }) => void;
}

let observer: LocalVcsCommandObserver | null = null;

export function setLocalVcsCommandObserver(
  next: LocalVcsCommandObserver | null,
): void {
  observer = next;
}

const execFilePromise = promisify(execFile);

export async function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions & { encoding?: "utf8" | BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  const finish = observer?.start({
    file,
    args,
    cwd: options.cwd === undefined ? undefined : String(options.cwd),
  });

  try {
    const result = await execFilePromise(file, args, {
      ...options,
      encoding: options.encoding ?? "utf8",
    });

    finish?.({ ok: true });

    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    finish?.({ ok: false });
    throw error;
  }
}

export function execFileSyncObserved(
  file: string,
  args: string[],
  options: ExecFileSyncOptions,
): string {
  const finish = observer?.start({
    file,
    args,
    cwd: options.cwd === undefined ? undefined : String(options.cwd),
  });

  try {
    const output = execFileSync(file, args, options);
    finish?.({ ok: true });

    return String(output);
  } catch (error) {
    finish?.({ ok: false });
    throw error;
  }
}

/**
 * A long-lived process the caller drives over stdin/stdout. The observer sees
 * exactly one spawn, completed when the process is up or when it could not
 * start. Piped stdio are sockets, which Node's types widen to plain streams;
 * the caller needs their `ref`/`unref` to leave an idle process detached from
 * the event loop.
 */
export function spawnObserved(
  file: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, "ignore">,
): ChildProcessByStdio<Socket, Socket, null> {
  const finish = observer?.start({
    file,
    args,
    cwd: options.cwd === undefined ? undefined : String(options.cwd),
  });

  try {
    // SAFETY: the stdio tuple this signature accepts pipes stdin and stdout,
    // and a piped child stream is a net.Socket.
    const child = spawn(file, args, options) as ChildProcessByStdio<
      Socket,
      Socket,
      null
    >;

    let finished = false;

    const complete = (ok: boolean) => {
      if (finished) return;
      finished = true;
      finish?.({ ok });
    };

    /* The span ends when the process is up, not when it exits: a reader keeps
       one alive for minutes, and the work in between is the caller's. */
    child.once("spawn", () => complete(true));
    child.once("error", () => complete(false));

    return child;
  } catch (error) {
    finish?.({ ok: false });

    throw error;
  }
}
