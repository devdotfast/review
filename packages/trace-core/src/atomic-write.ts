import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
  replaceSymlink?: boolean;
  tmpfileCreated?: (tmpfile: string) => void;
}

// Same-path writes retain invocation order, including after a failed write.
// Entries live only until the last pending write settles.
const inFlight = new Map<string, Promise<void>>();

function temporaryPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
}

function snapshotContents(contents: string | Uint8Array): string | Buffer {
  return contents instanceof Uint8Array ? Buffer.from(contents) : contents;
}

function toBuffer(
  contents: string | Buffer,
  encoding?: BufferEncoding,
): Buffer {
  return contents instanceof Uint8Array
    ? contents
    : Buffer.from(contents, encoding ?? "utf8");
}

function canIgnoreMetadataError(error: Error): boolean {
  if (!("code" in error)) return false;

  return (
    error.code === "ENOSYS" ||
    ((!process.getuid || process.getuid() !== 0) &&
      (error.code === "EINVAL" || error.code === "EPERM"))
  );
}

/**
 * Replace a file through a flushed sibling, preserving an existing symlink's
 * target and metadata. Exceptions clean up temporary files; process termination may leave them.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string | Uint8Array,
  encoding?: BufferEncoding,
  options: AtomicWriteOptions = {},
): void {
  const snapshot = snapshotContents(contents);
  mkdirSync(path.dirname(filePath), { recursive: true });
  let target = filePath;

  if (!options.replaceSymlink) {
    try {
      target = realpathSync(filePath);
    } catch {
      /* A new file has no real path yet. */
    }
  }

  let metadata: Stats | undefined;

  try {
    const candidate = options.replaceSymlink
      ? lstatSync(target)
      : statSync(target);

    if (!candidate.isSymbolicLink()) metadata = candidate;
  } catch {
    /* Match new-file defaults when stat is unavailable. */
  }

  const mode = options.mode || metadata?.mode;
  const tmp = temporaryPath(target);
  let fd: number | undefined;
  let created = false;

  try {
    fd = openSync(tmp, "wx", mode ?? 0o666);
    created = true;
    options.tmpfileCreated?.(tmp);
    const buffer = toBuffer(snapshot, encoding);
    let offset = 0;

    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);

      if (written === 0) throw new Error("Atomic write made no progress");
      offset += written;
    }

    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (metadata && process.getuid) {
      try {
        chownSync(tmp, metadata.uid, metadata.gid);
      } catch (error) {
        if (!(error instanceof Error) || !canIgnoreMetadataError(error))
          throw error;
      }
    }

    if (mode) {
      try {
        chmodSync(tmp, mode);
      } catch (error) {
        if (!(error instanceof Error) || !canIgnoreMetadataError(error))
          throw error;
      }
    }

    renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Preserve the primary write failure. */
      }
    }

    if (created) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* Preserve the primary write failure. */
      }
    }

    throw error;
  }
}

async function replaceFile(
  filePath: string,
  contents: string | Buffer,
  options: AtomicWriteOptions & { encoding?: BufferEncoding },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const target = options.replaceSymlink
    ? filePath
    : await realpath(filePath).catch(() => filePath);

  const candidate = options.replaceSymlink
    ? await lstat(target).catch(() => undefined)
    : await stat(target).catch(() => undefined);

  const metadata = candidate?.isSymbolicLink() ? undefined : candidate;
  const mode = options.mode ?? metadata?.mode;
  const tmp = temporaryPath(target);
  let handle: FileHandle | undefined;
  let created = false;

  try {
    handle = await open(tmp, "wx", mode ?? 0o666);
    created = true;
    await options.tmpfileCreated?.(tmp);
    const buffer = toBuffer(contents, options.encoding);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
      );

      if (bytesWritten === 0) throw new Error("Atomic write made no progress");
      offset += bytesWritten;
    }

    await handle.sync();
    await handle.close();
    handle = undefined;

    if (metadata && process.getuid) {
      await chown(tmp, metadata.uid, metadata.gid).catch((error) => {
        if (!(error instanceof Error) || !canIgnoreMetadataError(error))
          throw error;
      });
    }

    if (mode) {
      await chmod(tmp, mode).catch((error) => {
        if (!(error instanceof Error) || !canIgnoreMetadataError(error))
          throw error;
      });
    }

    await rename(tmp, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);

    if (created) await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Replace a file atomically, awaiting its callback and earlier writes to the same path. */
export async function writeFileAtomicAsync(
  filePath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions & { encoding?: BufferEncoding } = {},
): Promise<void> {
  const snapshot = snapshotContents(contents);
  const key = path.resolve(filePath);
  const previous = inFlight.get(key) ?? Promise.resolve();

  const pending = previous
    .catch(() => undefined)
    .then(() => replaceFile(filePath, snapshot, options));

  inFlight.set(key, pending);

  try {
    await pending;
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}

/**
 * Write JSON with owner-only permissions on the file and on a directory
 * this call creates. Login tokens and consent files use it.
 */
export async function writePrivateJsonAtomic<T>(
  filePath: string,
  value: T,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomicAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
