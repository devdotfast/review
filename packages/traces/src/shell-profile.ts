// The PATH block the standalone install owns in a login shell profile. The
// Review app has the same helpers, but the standalone package cannot bundle
// app code, so it keeps its own copy with its own marker.

import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomicAsync } from "@dev.fast/trace-core";

/** The first line of the block this package owns. */
export const PROFILE_MARKER =
  "# Managed by @dev.fast/traces: dev-traces command PATH. Do not edit.";

/** The one line the block adds to PATH. */
export const PROFILE_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';

/** The whole block, with the blank line that separates it from the file. */
export const PROFILE_BLOCK = `\n${PROFILE_MARKER}\n${PROFILE_EXPORT}\n`;

/** The login profiles this package writes and reads. */
export const SHELL_PROFILE_NAMES = [".zprofile", ".bash_profile"] as const;

const MANUAL_PATH_MESSAGE =
  "dev-traces did not change PATH for this shell. Add ~/.local/bin to PATH. Fish users can run: fish_add_path ~/.local/bin\n";

/** The file text, or an empty string when the file is absent or unreadable. */
export async function readTextIfExists(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch(() => "");
}

/** True when `pathValue` holds `directory` as one of its entries. */
export function pathContainsDirectory(
  pathValue: string | undefined,
  directory: string,
): boolean {
  return (pathValue ?? "")
    .split(path.delimiter)
    .some(
      (entry) =>
        entry.length > 0 && path.resolve(entry) === path.resolve(directory),
    );
}

/** True when `target` is a file this process can run. */
export async function isExecutableFile(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null);

  if (!info?.isFile()) return false;

  return access(target, constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function writeTextAtomic(
  filePath: string,
  source: string,
): Promise<void> {
  const info = await stat(filePath).catch(() => null);

  await writeFileAtomicAsync(filePath, source, {
    encoding: "utf8",
    mode: info ? info.mode & 0o777 : 0o644,
  });
}

/** The login profile of the shell in `env`, or null when none is known. */
function profileFileName(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): (typeof SHELL_PROFILE_NAMES)[number] | null {
  const shell = path.basename(env.SHELL?.trim() ?? "");

  if (shell === "bash") return ".bash_profile";

  if (shell === "zsh" || (shell !== "fish" && platform === "darwin")) {
    return ".zprofile";
  }

  return null;
}

export interface EnsureShellProfilePathInput {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  shimDirectory: string;
  platform?: NodeJS.Platform;
}

export interface EnsureShellProfilePathResult {
  /** True only when this call wrote the block. */
  added: boolean;
  /** The one human line the install prints; empty when there is nothing to say. */
  output: string;
}

/** Adds the shim directory to PATH in the login profile, once. */
export async function ensureShellProfilePath(
  input: EnsureShellProfilePathInput,
): Promise<EnsureShellProfilePathResult> {
  if (pathContainsDirectory(input.env.PATH, input.shimDirectory)) {
    return { added: false, output: "" };
  }

  const name = profileFileName(input.env, input.platform ?? process.platform);

  if (!name) return { added: false, output: MANUAL_PATH_MESSAGE };

  const profilePath = path.join(input.homeDir, name);
  const source = await readTextIfExists(profilePath);

  // A profile that already reaches ~/.local/bin needs no second block, even
  // when another tool wrote the line.
  if (source.includes(PROFILE_MARKER) || source.includes(".local/bin")) {
    return { added: false, output: "" };
  }

  await writeTextAtomic(profilePath, `${source}${PROFILE_BLOCK}`);

  return {
    added: true,
    output: `[ok] added ${input.shimDirectory} to PATH in ${profilePath}\n`,
  };
}

/** Removes the block from every profile that has it; returns those paths. */
export async function removeShellProfilePath(
  homeDir: string,
): Promise<string[]> {
  const removed: string[] = [];

  for (const name of SHELL_PROFILE_NAMES) {
    const profilePath = path.join(homeDir, name);
    const source = await readTextIfExists(profilePath);

    if (!source.includes(PROFILE_BLOCK)) continue;
    await writeTextAtomic(profilePath, source.replaceAll(PROFILE_BLOCK, ""));
    removed.push(profilePath);
  }

  return removed;
}

/**
 * The executable named `command` that PATH reaches before `shimPath`, or
 * undefined when nothing shadows the shim. A file that carries `ownMarker` is
 * one of ours and never shadows. Neither does a file that resolves to
 * `ignoreRealPath`: under npx the cache puts a `.bin` link to the running
 * package on PATH, and that link runs the same code as the shim.
 */
export async function resolvePathCommand(
  command: string,
  shimPath: string,
  env: NodeJS.ProcessEnv,
  ownMarker: string,
  ignoreRealPath?: string,
): Promise<string | undefined> {
  const entries = (env.PATH ?? "").split(path.delimiter);
  const shimDirectory = path.resolve(path.dirname(shimPath));

  const shimIndex = entries.findIndex(
    (entry) => path.resolve(entry || ".") === shimDirectory,
  );

  for (let index = 0; index < entries.length; index += 1) {
    const candidate = path.join(entries[index] || ".", command);

    if (!(await isExecutableFile(candidate))) continue;

    if (
      ignoreRealPath !== undefined &&
      (await realPathOrNull(candidate)) === ignoreRealPath
    ) {
      continue;
    }

    if ((await readTextIfExists(candidate)).includes(ownMarker)) {
      return undefined;
    }

    return shimIndex === -1 || index < shimIndex
      ? path.resolve(candidate)
      : undefined;
  }

  return undefined;
}

async function realPathOrNull(filePath: string): Promise<string | null> {
  return realpath(filePath).catch(() => null);
}
