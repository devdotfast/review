import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import writeFileAtomicPackage from "write-file-atomic";

export interface AtomicWriteOptions {
  mode?: number;
  tmpfileCreated?: (tmpfile: string) => void;
}

/**
 * Write a file atomically through a same-directory temporary file. A
 * concurrent reader always sees either the complete old file or the complete
 * new one, and the package cleans up an interrupted temporary write.
 *
 * Signature mirrors `writeFileSync(path, data, "utf8")` so it is a drop-in
 * replacement; byte contents are written verbatim.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string | Uint8Array,
  encoding?: BufferEncoding,
  options: AtomicWriteOptions = {},
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomicPackage.sync(
    filePath,
    contents instanceof Uint8Array ? Buffer.from(contents) : contents,
    {
      encoding,
      mode: options.mode,
      tmpfileCreated: options.tmpfileCreated,
    },
  );
}

export async function writeFileAtomicAsync(
  filePath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions & { encoding?: BufferEncoding } = {},
): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFileAtomicPackage(
    filePath,
    contents instanceof Uint8Array ? Buffer.from(contents) : contents,
    options,
  );
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
