import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { gitCommonDir } from "@dev.fast/local-vcs";
import type {
  HostBinding,
  HostSourceQuote,
  HostSourceRange,
} from "@dev.fast/review-protocol";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_QUOTE_BYTES = 256 * 1024;
const MAX_RANGE_LINES = 1000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type EvidenceProviderErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "DEPENDENCY_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "RESOURCE_LIMIT";

/** Public failures deliberately exclude local paths and subprocess output. */
export class EvidenceProviderError extends Error {
  override readonly name = "EvidenceProviderError";

  constructor(
    readonly code: EvidenceProviderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface EvidenceProvider {
  resolve(
    binding: HostBinding,
    range: HostSourceRange,
  ): Promise<HostSourceQuote>;
}

/** Reads committed objects from Git or a Git-backed jj repository. No checkout
 * preparation, worktree reads, filters, or authored code are involved. */
export class LocalEvidenceProvider implements EvidenceProvider {
  constructor(
    private readonly resolveRepository: (
      repositoryId: string,
    ) => string | Promise<string>,
  ) {}

  async resolve(
    binding: HostBinding,
    range: HostSourceRange,
  ): Promise<HostSourceQuote> {
    validateRange(range);
    const commit =
      range.side === "base" ? binding.baseCommit : binding.headCommit;
    if (!OBJECT_ID.test(commit)) {
      throw new EvidenceProviderError(
        "INVALID_REQUEST",
        "Source evidence requires a full immutable commit ID.",
      );
    }

    let gitDir: string | null;
    try {
      const repositoryPath = await this.resolveRepository(binding.repositoryId);
      if (!repositoryPath || !path.isAbsolute(repositoryPath))
        throw new Error();
      // This resolver understands linked worktrees and non-colocated jj stores.
      gitDir = await gitCommonDir(repositoryPath);
    } catch {
      throw repositoryUnavailable();
    }
    if (!gitDir) throw repositoryUnavailable();

    const type = await readGitObject(gitDir, ["cat-file", "-t", commit], {
      failureCode: "NOT_FOUND",
    });
    if (type.toString("utf8").trim() !== "commit") {
      throw new EvidenceProviderError(
        "INVALID_REQUEST",
        "Source evidence must identify a commit, not another Git object.",
      );
    }

    const listed = await readGitObject(
      gitDir,
      ["ls-tree", "-z", "-l", commit, "--", range.file],
      { maxBytes: 8192 },
    );
    const entries = listed.toString("utf8").split("\0").filter(Boolean);
    const entry = entries.find(
      (value) => value.slice(value.indexOf("\t") + 1) === range.file,
    );
    if (!entry) {
      throw new EvidenceProviderError(
        "NOT_FOUND",
        "The source file is absent from the pinned commit.",
      );
    }
    const header = entry.slice(0, entry.indexOf("\t")).trim().split(/\s+/);
    const [mode, objectType, blob, rawSize] = header;
    if ((mode !== "100644" && mode !== "100755") || objectType !== "blob") {
      throw new EvidenceProviderError(
        "VALIDATION_FAILED",
        "Source evidence must be a regular file, not a symlink, directory, or submodule.",
      );
    }
    const byteLength = Number(rawSize);
    if (
      !blob ||
      !OBJECT_ID.test(blob) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0
    ) {
      throw repositoryUnavailable();
    }
    if (byteLength > MAX_FILE_BYTES) {
      throw new EvidenceProviderError(
        "RESOURCE_LIMIT",
        "Source files may not exceed 1 MiB.",
      );
    }

    const bytes = await readGitObject(gitDir, ["cat-file", "blob", blob], {
      maxBytes: MAX_FILE_BYTES,
    });
    if (bytes.byteLength !== byteLength) throw repositoryUnavailable();
    let source: string;
    try {
      if (bytes.includes(0)) throw new Error();
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new EvidenceProviderError(
        "VALIDATION_FAILED",
        "Source evidence must be UTF-8 text, not a binary file.",
      );
    }
    const lines = source === "" ? [] : source.split(/\r?\n/);
    // A terminating newline does not introduce another source line.
    if (source.endsWith("\n")) lines.pop();
    if (range.toLine > lines.length) {
      throw new EvidenceProviderError(
        "INVALID_REQUEST",
        "The source range exceeds the file's line count.",
      );
    }
    // Quotations use LF consistently; the blob ID retains exact-byte provenance.
    const text = lines.slice(range.fromLine - 1, range.toLine).join("\n");
    if (Buffer.byteLength(text, "utf8") > MAX_QUOTE_BYTES) {
      throw new EvidenceProviderError(
        "RESOURCE_LIMIT",
        "Source quotations may not exceed 256 KiB.",
      );
    }
    return {
      span: {
        repositoryId: binding.repositoryId,
        commit,
        blob,
        file: range.file,
        fromLine: range.fromLine,
        toLine: range.toLine,
      },
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  }
}

function validateRange(range: HostSourceRange): void {
  if (
    (range.side !== "base" && range.side !== "head") ||
    !Number.isSafeInteger(range.fromLine) ||
    !Number.isSafeInteger(range.toLine) ||
    range.fromLine < 1 ||
    range.toLine < range.fromLine
  ) {
    throw new EvidenceProviderError(
      "INVALID_REQUEST",
      "Source ranges require a side and ordered positive line numbers.",
    );
  }
  if (range.toLine - range.fromLine + 1 > MAX_RANGE_LINES) {
    throw new EvidenceProviderError(
      "RESOURCE_LIMIT",
      "Source quotations may not exceed 1000 lines.",
    );
  }
  if (
    !range.file ||
    Buffer.byteLength(range.file, "utf8") > 4096 ||
    /[:\u0000-\u001f\u007f\\]/.test(range.file) ||
    path.posix.isAbsolute(range.file) ||
    path.win32.isAbsolute(range.file) ||
    range.file.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new EvidenceProviderError(
      "INVALID_REQUEST",
      "Source paths must be repository-relative paths without traversal.",
    );
  }
}

function repositoryUnavailable(): EvidenceProviderError {
  return new EvidenceProviderError(
    "DEPENDENCY_UNAVAILABLE",
    "The source repository is unavailable.",
  );
}

function readGitObject(
  gitDir: string,
  args: string[],
  options: { maxBytes?: number; failureCode?: EvidenceProviderErrorCode } = {},
): Promise<Buffer> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
  });
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-replace-objects", "--git-dir", gitDir, ...args],
      {
        encoding: "buffer",
        env,
        timeout: 10_000,
        maxBuffer: options.maxBytes ?? 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            options.failureCode === "NOT_FOUND" && error.code === 128
              ? new EvidenceProviderError(
                  "NOT_FOUND",
                  "The pinned source commit is unavailable.",
                )
              : repositoryUnavailable(),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
