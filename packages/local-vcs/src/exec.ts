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

/** Long-lived child; the observer sees one spawn, completed once the process is up. */
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
    // SAFETY: piped stdin/stdout are net.Sockets.
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

    child.once("spawn", () => complete(true));
    child.once("error", () => complete(false));

    return child;
  } catch (error) {
    finish?.({ ok: false });

    throw error;
  }
}
