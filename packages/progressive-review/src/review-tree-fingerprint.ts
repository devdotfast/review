import { type Hash, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface ReviewTreeOptions {
  /** Receives the path relative to the walked root. */
  include: (relativePath: string) => boolean;
  symlink: "hash-target" | "reject";
}

interface ReviewTreeVisitor {
  directory?: (relativePath: string) => Promise<void>;
  file?: (relativePath: string, contents: Buffer) => Promise<void>;
}

async function walkReviewTree(
  dir: string,
  options: ReviewTreeOptions,
  digest: Hash,
  visitor: ReviewTreeVisitor,
): Promise<void> {
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(dir, relative), {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relative, entry.name);
      if (!options.include(relativePath)) continue;
      digest.update(`${relativePath}\0`);
      if (entry.isDirectory()) {
        digest.update("directory\0");
        await visitor.directory?.(relativePath);
        await walk(relativePath);
      } else if (entry.isSymbolicLink()) {
        if (options.symlink === "reject") {
          throw new Error(
            `Review authoring contains an unsupported symbolic link: ${relativePath}`,
          );
        }
        digest.update(
          `link\0${await readlink(path.join(dir, relativePath))}\0`,
        );
      } else if (entry.isFile()) {
        const contents = await readFile(path.join(dir, relativePath));
        digest.update("file\0");
        digest.update(contents);
        digest.update("\0");
        await visitor.file?.(relativePath, contents);
      } else {
        throw new Error(
          `Review authoring contains an unsupported file: ${relativePath}`,
        );
      }
    }
  };
  await walk("");
}

/** Digest of every included entry: names, kinds, file bytes and link targets. */
export async function fingerprintReviewTree(
  dir: string,
  options: ReviewTreeOptions,
): Promise<string> {
  const digest = createHash("sha256");
  await walkReviewTree(dir, options, digest, {});
  return digest.digest("hex");
}

/** Copies the included entries and returns the digest of exactly what it
 * copied, so a caller can compare it against a later fingerprint of the
 * source. */
export async function copyReviewTree(
  dir: string,
  destination: string,
  options: ReviewTreeOptions,
): Promise<string> {
  const digest = createHash("sha256");
  await walkReviewTree(dir, options, digest, {
    directory: async (relativePath) => {
      await mkdir(path.join(destination, relativePath), { recursive: true });
    },
    file: async (relativePath, contents) => {
      await writeFile(path.join(destination, relativePath), contents);
    },
  });
  return digest.digest("hex");
}
