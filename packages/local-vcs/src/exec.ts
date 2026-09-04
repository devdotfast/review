// Every git/jj subprocess this package spawns goes through these two
// wrappers so a host (the Review CLI's startup tracer) can observe each spawn
// without this package depending on any tracing library. Without an observer
// they are plain `execFile` / `execFileSync`.
import {
  type ExecFileOptions,
  type ExecFileSyncOptions,
  execFile,
  execFileSync,
} from "node:child_process";
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
