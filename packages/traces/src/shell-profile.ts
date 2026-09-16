// The PATH setup of the standalone install, done the way rustup and Volta do
// it: one self-guarding env file under the trace home, and one `source` line
// appended to the startup files of every shell on the machine. The install
// never creates a bash file: a new `~/.bash_profile` makes bash skip
// `~/.profile` and `~/.bashrc` at login, which breaks a Debian user's shell.
// The Review app has similar helpers, but the standalone package cannot bundle
// app code, so it keeps its own copy.

import {
  access,
  appendFile,
  constants,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { errorMessage, writeFileAtomicAsync } from "@dev.fast/trace-core";

/** The env variable that turns the shell file edits off. */
export const NO_MODIFY_PATH_VARIABLE = "DEV_TRACES_NO_MODIFY_PATH";

const ENV_MARKER = "# Managed by @dev.fast/traces. Do not edit.";

/** The env file for POSIX shells. The guard keeps PATH free of a second entry. */
const ENV_SOURCE = `${ENV_MARKER}
case ":\${PATH}:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
`;

const FISH_ENV_SOURCE = `${ENV_MARKER}
if not contains -- "$HOME/.local/bin" $PATH
  set -gx PATH "$HOME/.local/bin" $PATH
end
`;

/** The first line of the block an earlier version of this package wrote. */
export const LEGACY_PROFILE_MARKER =
  "# Managed by @dev.fast/traces: dev-traces command PATH. Do not edit.";

const LEGACY_PROFILE_BLOCK = `\n${LEGACY_PROFILE_MARKER}\nexport PATH="$HOME/.local/bin:$PATH"\n`;

/** The bash startup files the install appends to when they exist. */
const BASH_FILE_NAMES = [".bash_profile", ".bash_login", ".bashrc"] as const;

/** The file text, or an empty string when the file is absent or unreadable. */
export async function readTextIfExists(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch(() => "");
}

/** The file text, or null when the file is absent or unreadable. */
async function readTextOrNull(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch(() => null);
}

/** The file text, or null when the file is absent. Any other error throws. */
async function readTextOrAbsent(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;

    throw error;
  });
}

/** True when one line of `source` is `line`; a CRLF file counts too. */
function hasLine(source: string, line: string): boolean {
  return source.split("\n").some((each) => each.replace(/\r$/, "") === line);
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

/** The env file POSIX shells source. */
export function envFilePath(devHome: string): string {
  return path.join(devHome, "traces", "env");
}

/** The env file fish sources. */
export function fishEnvFilePath(devHome: string): string {
  return path.join(devHome, "traces", "env.fish");
}

/**
 * The env file path as the shell files spell it. The default trace home stays
 * `$HOME`-relative, so the line survives a home directory move; a custom
 * `DEV_REVIEW_HOME` is written in full, because a login shell has not read
 * that variable yet.
 */
function envPathText(devHome: string, homeDir: string, name: string): string {
  const isDefaultHome =
    path.resolve(devHome) === path.resolve(path.join(homeDir, ".dev"));

  return isDefaultHome
    ? `$HOME/.dev/traces/${name}`
    : path.join(devHome, "traces", name);
}

/** The one line the install appends to a POSIX shell file. */
export function posixSourceLine(devHome: string, homeDir: string): string {
  return `. "${envPathText(devHome, homeDir, "env")}"`;
}

/** The one line the install writes to the fish drop-in. */
export function fishSourceLine(devHome: string, homeDir: string): string {
  return `source "${envPathText(devHome, homeDir, "env.fish")}"`;
}

function zshenvPath(homeDir: string, env: NodeJS.ProcessEnv): string {
  return path.join(env.ZDOTDIR?.trim() || homeDir, ".zshenv");
}

function fishDropInPath(homeDir: string, env: NodeJS.ProcessEnv): string {
  const configHome =
    env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");

  return path.join(configHome, "fish", "conf.d", "dev-traces.fish");
}

/** True when `$SHELL` is this shell, or PATH reaches its binary. */
async function shellPresent(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (path.basename(env.SHELL?.trim() ?? "") === name) return true;

  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (entry && (await isExecutableFile(path.join(entry, name)))) return true;
  }

  return false;
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function writeEnvFiles(devHome: string): Promise<void> {
  await mkdir(path.join(devHome, "traces"), { recursive: true });

  await writeFileAtomicAsync(envFilePath(devHome), ENV_SOURCE, {
    encoding: "utf8",
    mode: 0o644,
  });

  await writeFileAtomicAsync(fishEnvFilePath(devHome), FISH_ENV_SOURCE, {
    encoding: "utf8",
    mode: 0o644,
  });
}

type AppendResult =
  | { status: "created" | "added" | "unchanged" }
  | { status: "failed"; message: string };

/**
 * Appends `line` to the end of `filePath` once. The append keeps the inode, so
 * a profile that is a link into a dotfiles checkout stays a link. A file this
 * process cannot read or write is reported, not thrown: the shim is already
 * in place, and the other shell files still get their line.
 */
async function appendLineOnce(
  filePath: string,
  line: string,
): Promise<AppendResult> {
  try {
    const source = await readTextOrAbsent(filePath);

    if (source !== null && hasLine(source, line))
      return { status: "unchanged" };

    const separator =
      source === null || source.length === 0 || source.endsWith("\n")
        ? ""
        : "\n";

    await mkdir(path.dirname(filePath), { recursive: true });

    await appendFile(filePath, `${separator}${line}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });

    return { status: source === null ? "created" : "added" };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

export interface ShellProfileInput {
  homeDir: string;
  devHome: string;
  env: NodeJS.ProcessEnv;
}

export interface EnsureShellProfilePathInput extends ShellProfileInput {
  shimDirectory: string;
}

export interface EnsureShellProfilePathResult {
  /** The files this call appended the source line to. */
  added: string[];
  /** The files this call created; each one is also in `added`. */
  created: string[];
  /** Why this call changed nothing, or null when it ran. */
  skipped: string | null;
  /** The human lines the install prints; empty when there is nothing to say. */
  output: string;
}

/** Puts the shim directory on PATH in the startup files of every shell present. */
export async function ensureShellProfilePath(
  input: EnsureShellProfilePathInput,
): Promise<EnsureShellProfilePathResult> {
  const skipped =
    input.env[NO_MODIFY_PATH_VARIABLE] === "1"
      ? `${NO_MODIFY_PATH_VARIABLE}=1 is set; no shell file was changed`
      : pathContainsDirectory(input.env.PATH, input.shimDirectory)
        ? `${input.shimDirectory} is already on PATH; no shell file was changed`
        : null;

  if (skipped)
    return { added: [], created: [], skipped, output: `${skipped}\n` };

  await writeEnvFiles(input.devHome);
  const posixLine = posixSourceLine(input.devHome, input.homeDir);
  const targets: { file: string; line: string }[] = [];

  // sh, always: `~/.profile` is what every login shell reads when nothing
  // more specific exists, and it is the file bash falls back to.
  targets.push({ file: path.join(input.homeDir, ".profile"), line: posixLine });

  let bashNote = "";

  if (await shellPresent("bash", input.env)) {
    const bashFiles: string[] = [];

    for (const name of BASH_FILE_NAMES) {
      const file = path.join(input.homeDir, name);

      if (await exists(file)) bashFiles.push(file);
    }

    if (bashFiles.length === 0) {
      bashNote =
        "bash reads ~/.profile at login; no bash rc file was created.\n";
    }

    for (const file of bashFiles) targets.push({ file, line: posixLine });
  }

  if (await shellPresent("zsh", input.env)) {
    targets.push({
      file: zshenvPath(input.homeDir, input.env),
      line: posixLine,
    });
  }

  if (await shellPresent("fish", input.env)) {
    targets.push({
      file: fishDropInPath(input.homeDir, input.env),
      line: fishSourceLine(input.devHome, input.homeDir),
    });
  }

  const added: string[] = [];
  const created: string[] = [];
  const lines: string[] = [];

  for (const target of targets) {
    const result = await appendLineOnce(target.file, target.line);

    if (result.status === "unchanged") continue;

    if (result.status === "failed") {
      lines.push(`[warn] could not update ${target.file}: ${result.message}\n`);
      continue;
    }

    added.push(target.file);
    lines.push(`[ok] added ${target.file} to PATH setup\n`);

    if (result.status === "created") {
      created.push(target.file);
      lines.push(`[ok] created ${target.file}\n`);
    }
  }

  if (added.length > 0) {
    lines.push(
      bashNote,
      `To set up PATH in another shell, run: ${posixLine}\n`,
    );
  }

  return { added, created, skipped: null, output: lines.join("") };
}

/** Every shell file the install writes or wrote, with the line it holds. */
function candidateFiles(
  input: ShellProfileInput,
): { file: string; line: string; dropIn: boolean }[] {
  const posixLine = posixSourceLine(input.devHome, input.homeDir);

  const names = [
    ".profile",
    ...BASH_FILE_NAMES,
    // The earlier implementation wrote `.zprofile`.
    ".zprofile",
  ];

  return [
    ...names.map((name) => ({
      file: path.join(input.homeDir, name),
      line: posixLine,
      dropIn: false,
    })),
    {
      file: zshenvPath(input.homeDir, input.env),
      line: posixLine,
      dropIn: false,
    },
    {
      file: fishDropInPath(input.homeDir, input.env),
      line: fishSourceLine(input.devHome, input.homeDir),
      dropIn: true,
    },
  ];
}

/** The shell files that hold the source line. */
export async function shellProfilesWithPathSetup(
  input: ShellProfileInput,
): Promise<string[]> {
  const found: string[] = [];

  for (const candidate of candidateFiles(input)) {
    const source = await readTextOrNull(candidate.file);

    if (source !== null && hasLine(source, candidate.line)) {
      found.push(candidate.file);
    }
  }

  return found;
}

/**
 * Removes the source line, and the block of the earlier implementation, from
 * every shell file that holds one; then deletes the env files. Returns the
 * files it changed. A profile is never deleted: only the fish drop-in, and a
 * file that held the legacy block and holds nothing else once it is gone, go
 * away. That second file is the `.bash_profile` an earlier install created;
 * left behind empty, it would keep bash from reading `~/.profile` at login.
 */
export async function removeShellProfilePath(
  input: ShellProfileInput,
): Promise<string[]> {
  const changed: string[] = [];

  for (const candidate of candidateFiles(input)) {
    const source = await readTextOrNull(candidate.file);

    if (source === null) continue;

    const next = source
      .split("\n")
      .filter((line) => line.replace(/\r$/, "") !== candidate.line)
      .join("\n")
      .replaceAll(LEGACY_PROFILE_BLOCK, "");

    if (next === source) continue;

    const ownFile =
      next.trim() === "" &&
      (candidate.dropIn || source.includes(LEGACY_PROFILE_BLOCK));

    if (ownFile) {
      await rm(candidate.file, { force: true });
    } else {
      // The atomic write replaces the resolved file, so a profile that is a
      // link into a dotfiles checkout stays a link, and a crash mid-write
      // never leaves a truncated profile behind.
      const target = await realpath(candidate.file);
      const info = await stat(target);

      await writeFileAtomicAsync(target, next, {
        encoding: "utf8",
        mode: info.mode & 0o777,
      });
    }

    changed.push(candidate.file);
  }

  await rm(envFilePath(input.devHome), { force: true });
  await rm(fishEnvFilePath(input.devHome), { force: true });

  return changed;
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
