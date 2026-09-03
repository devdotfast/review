import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { withFileLock, withFileLockSync } from "./file-lock";
import {
  git,
  gitArgs,
  gitArgsSync,
  gitCommonDir,
  gitCommonDirSync,
} from "./index";

const execFileAsync = promisify(execFile);

const NOTES_LOCK_STALE_MS = 60_000;
const NOTES_LOCK_POLL_MS = 50;
const NOTES_LOCK_TIMEOUT_MS = 60_000;
// The sync variant busy-spins the event loop while it waits (it runs inside
// the Vite dev server, not just CLI one-shots), so it fails fast instead of
// spinning for the full async budget.
const NOTES_LOCK_SYNC_TIMEOUT_MS = 2_000;
const NOTES_LOCK_TOUCH_MS = 5_000;
const NOTES_WRITE_RETRIES = 3;

/**
 * Failing to acquire the notes lock fails the operation: running the critical
 * section unlocked would corrupt concurrent writers, and deleting someone
 * else's lock afterwards would corrupt the *next* writer too.
 */
export class NotesLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    super(
      `Timed out after ${waitedMs}ms waiting for the dev-fast notes lock at ${lockPath}. ` +
        "Another process is holding it; retry once that writer finishes.",
    );
    this.name = "NotesLockTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Read a single note. Returns the exact blob content (notes are written via
 * hash-object, so no stripspace normalization has occurred).
 */
export async function readNote(input: {
  rootPath: string;
  ref: string;
  commit: string;
}): Promise<string | null> {
  const batch = await readNotesBatch({
    rootPath: input.rootPath,
    ref: input.ref,
    commits: [input.commit],
  });
  return batch.get(input.commit) ?? null;
}

export function readNoteSync(input: {
  rootPath: string;
  ref: string;
  commit: string;
}): string | null {
  try {
    return execFileSync(
      "git",
      gitArgsSync(input.rootPath, [
        "notes",
        `--ref=${input.ref}`,
        "show",
        input.commit,
      ]),
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return null;
  }
}

/**
 * Batch note reads: one `ls-tree -r` over the notes tree plus one
 * `cat-file --batch` process for the blob contents, instead of N
 * `git notes show` subprocesses. Handles flat and fanout (ab/cdef…) layouts —
 * a note's key is its path with the separators removed.
 */
export async function readNotesBatch(input: {
  rootPath: string;
  ref: string;
  commits: readonly string[];
}): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (input.commits.length === 0) return result;

  const entries = await listNoteEntries(input.rootPath, input.ref);
  if (!entries) return result;

  const wanted = new Map<string, string>();
  for (const commit of input.commits) {
    const blob = entries.get(commit.toLowerCase());
    if (blob) wanted.set(commit, blob);
  }
  if (wanted.size === 0) return result;

  const contents = await catFileBatch(input.rootPath, [
    ...new Set(wanted.values()),
  ]);
  for (const [commit, blob] of wanted) {
    const content = contents.get(blob);
    if (content !== undefined) result.set(commit, content);
  }
  return result;
}

/** All annotated commits under a notes ref (lowercased hex → blob sha). */
async function listNoteEntries(
  rootPath: string,
  ref: string,
): Promise<Map<string, string> | null> {
  const tree = await git(rootPath, ["rev-parse", `${ref}^{tree}`], {
    allowFailure: true,
  });
  if (!tree.ok) return null;
  const lsTree = await git(rootPath, ["ls-tree", "-r", tree.stdout.trim()]);
  const entries = new Map<string, string>();
  for (const line of lsTree.stdout.split("\n")) {
    if (!line) continue;
    // <mode> SP <type> SP <sha>\t<path>
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(" ");
    if (meta[1] !== "blob") continue;
    const key = line
      .slice(tab + 1)
      .replaceAll("/", "")
      .toLowerCase();
    if (/^[0-9a-f]{40,64}$/.test(key)) entries.set(key, meta[2]);
  }
  return entries;
}

export async function listNoteCommits(input: {
  rootPath: string;
  ref: string;
}): Promise<string[]> {
  const entries = await listNoteEntries(input.rootPath, input.ref);
  return entries ? [...entries.keys()] : [];
}

async function catFileBatch(
  rootPath: string,
  blobShas: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (blobShas.length === 0) return result;
  const args = await gitArgs(rootPath, ["cat-file", "--batch"]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    // EPIPE on stdin (cat-file exiting early) must reject, not crash the
    // process via an unhandled stream error.
    child.stdin.on("error", (error) =>
      reject(new Error(`git cat-file --batch stdin failed: ${String(error)}`)),
    );
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file --batch failed: ${stderr}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      let offset = 0;
      for (const sha of blobShas) {
        const headerEnd = buffer.indexOf(0x0a, offset);
        if (headerEnd === -1) break;
        const header = buffer.slice(offset, headerEnd).toString();
        offset = headerEnd + 1;
        const parts = header.split(" ");
        if (parts[1] === "missing") continue;
        const size = Number.parseInt(parts[2] ?? "0", 10);
        result.set(sha, buffer.slice(offset, offset + size).toString("utf8"));
        offset += size + 1; // trailing LF after each object
      }
      resolve(result);
    });
    child.stdin.write(`${blobShas.join("\n")}\n`);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Attach content to a commit under a notes ref. The blob is written with
 * `hash-object -w` and attached via `git notes add -C <sha>` so the content is
 * stored byte-for-byte (`git notes add -F` would run stripspace and mangle
 * source code). Serialized against concurrent local writers with a file lock;
 * ref races from writers outside the lock are retried.
 */
export async function writeNote(input: {
  rootPath: string;
  ref: string;
  commit: string;
  content: string;
}): Promise<void> {
  await ensureNotesConfig({ rootPath: input.rootPath });
  await withNotesLock(input.rootPath, async () => {
    const tmp = path.join(
      os.tmpdir(),
      `dev-fast-note-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(tmp, input.content, "utf8");
    try {
      // --no-filters: notes are a byte-for-byte contract; gitattributes/
      // autocrlf must not run text conversion over the blob.
      const hashed = await git(input.rootPath, [
        "hash-object",
        "-w",
        "--no-filters",
        tmp,
      ]);
      const blob = hashed.stdout.trim();
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < NOTES_WRITE_RETRIES; attempt += 1) {
        const added = await git(
          input.rootPath,
          [
            "notes",
            `--ref=${input.ref}`,
            "add",
            "-f",
            "-C",
            blob,
            input.commit,
          ],
          { allowFailure: true },
        );
        if (added.ok) return;
        lastError = new Error(added.stderr);
      }
      throw lastError;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}

export function writeNoteSync(input: {
  rootPath: string;
  ref: string;
  commit: string;
  content: string;
}): void {
  ensureNotesConfigSync({ rootPath: input.rootPath });
  withNotesLockSync(input.rootPath, () => {
    const tmp = path.join(
      os.tmpdir(),
      `dev-fast-note-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(tmp, input.content, "utf8");
    try {
      const blob = execFileSync(
        "git",
        gitArgsSync(input.rootPath, ["hash-object", "-w", "--no-filters", tmp]),
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < NOTES_WRITE_RETRIES; attempt += 1) {
        try {
          execFileSync(
            "git",
            gitArgsSync(input.rootPath, [
              "notes",
              `--ref=${input.ref}`,
              "add",
              "-f",
              "-C",
              blob,
              input.commit,
            ]),
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      throw lastError;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
}

/** Copy a note across a commit rewrite (old → new). No-op if `from` has none. */
export async function copyNote(input: {
  rootPath: string;
  ref: string;
  from: string;
  to: string;
}): Promise<boolean> {
  const source = await readNote({
    rootPath: input.rootPath,
    ref: input.ref,
    commit: input.from,
  });
  if (source === null) return false;
  await writeNote({
    rootPath: input.rootPath,
    ref: input.ref,
    commit: input.to,
    content: source,
  });
  return true;
}

/**
 * Reachability-based housekeeping for a notes ref. Drops note entries whose
 * annotated commits either no longer exist as objects, or are unreachable
 * from every ref AND are not the current commit of any jj workspace's `@`
 * (jj working copies are real commits that no ref points at, and their notes
 * are live authoring state). Returns the dropped commit ids.
 *
 * Invariant: prune must never delete the only note that evolog recovery
 * would use to heal a live change. Under jj, working-copy authoring strands
 * notes on dead predecessor commit ids of a live change; read-time evolog
 * recovery later backfills such a note onto the change's current commit —
 * but only if the stranded note still exists when the read happens. So for
 * every jj workspace's `@` change we walk its evolog newest-first and spare
 * the newest annotated commit — exactly the one recovery would pick. Older
 * annotated predecessors of the same change remain prunable.
 */
export async function pruneNotes(input: {
  rootPath: string;
  ref: string;
}): Promise<{ removed: string[] }> {
  // The whole classify→remove sequence holds the notes lock: a locked writer
  // landing a note between classification and removal must not race the
  // sweep (e.g. a fresh note on a commit classified as prunable).
  return withNotesLock(input.rootPath, () => pruneNotesLocked(input));
}

async function pruneNotesLocked(input: {
  rootPath: string;
  ref: string;
}): Promise<{ removed: string[] }> {
  const entries = await listNoteCommits(input);
  if (entries.length === 0) return { removed: [] };

  const existing: string[] = [];
  const missing: string[] = [];
  for (const commit of entries) {
    const exists = await git(
      input.rootPath,
      ["cat-file", "-e", `${commit}^{commit}`],
      { allowFailure: true },
    );
    (exists.ok ? existing : missing).push(commit);
  }

  const unreachable = await unreachableCommits(input.rootPath, existing);
  const workingCopyIds = await jjWorkingCopyCommitIds(input.rootPath);
  const workingCopies = new Set(workingCopyIds.map((id) => id.toLowerCase()));

  // The evolog-recovery seeds (see the invariant above): per workspace `@`
  // change, the newest evolog commit that has a note. When `@` itself is
  // annotated that is `@` (already spared as a working copy) and every
  // predecessor stays prunable — recovery never needs them.
  const annotated = new Set(entries.map((commit) => commit.toLowerCase()));
  const evologSpared = new Set<string>();
  for (const workingCopy of workingCopyIds) {
    const evolog = await evologCommitIds({
      rootPath: input.rootPath,
      ref: workingCopy,
    });
    for (const commit of evolog) {
      if (annotated.has(commit.toLowerCase())) {
        evologSpared.add(commit.toLowerCase());
        break;
      }
    }
  }

  const removed = [...missing];
  // `git notes prune` drops the entries whose commits no longer exist (they
  // cannot be named by `git notes remove`).
  if (missing.length > 0) {
    await git(input.rootPath, ["notes", `--ref=${input.ref}`, "prune"], {
      allowFailure: true,
    });
  }
  for (const commit of existing) {
    if (!unreachable.has(commit.toLowerCase())) continue;
    if (workingCopies.has(commit.toLowerCase())) continue;
    if (evologSpared.has(commit.toLowerCase())) continue;
    const dropped = await git(
      input.rootPath,
      ["notes", `--ref=${input.ref}`, "remove", commit],
      { allowFailure: true },
    );
    if (dropped.ok) removed.push(commit);
  }
  return { removed };
}

/** The subset of `commits` unreachable from every ref, as lowercase hex. */
async function unreachableCommits(
  rootPath: string,
  commits: readonly string[],
): Promise<Set<string>> {
  if (commits.length === 0) return new Set();
  // rev-list walks from the given commits, minus everything reachable from
  // any ref; a commit appearing in the output is reachable from no ref. The
  // commits ride on stdin (--stdin injects them at that argv position, i.e.
  // before --not --all): tens of thousands of shas overflow argv (E2BIG),
  // which would silently disable pruning's unreachability check.
  const args = await gitArgs(rootPath, [
    "rev-list",
    "--stdin",
    "--not",
    "--all",
  ]);
  const listed = await new Promise<{ ok: boolean; stdout: string }>(
    (resolve) => {
      const child = spawn("git", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) =>
        resolve({ ok: false, stdout: String(error) }),
      );
      child.once("close", (code) =>
        resolve(
          code === 0 ? { ok: true, stdout } : { ok: false, stdout: stderr },
        ),
      );
      child.stdin.on("error", () => {});
      child.stdin.write(`${commits.join("\n")}\n`);
      child.stdin.end();
    },
  );
  if (!listed.ok) {
    // Failing open (treating everything as reachable) is safe but must not
    // be silent: it disables pruning entirely.
    console.warn(
      `dev-fast notes prune: git rev-list reachability check failed; skipping unreachability-based pruning. ${listed.stdout.trim()}`,
    );
    return new Set();
  }
  const wanted = new Set(commits.map((commit) => commit.toLowerCase()));
  const unreachable = new Set<string>();
  for (const line of listed.stdout.split("\n")) {
    const commit = line.trim().toLowerCase();
    if (wanted.has(commit)) unreachable.add(commit);
  }
  return unreachable;
}

/** Current commit ids of every jj workspace's `@`; empty outside jj. */
async function jjWorkingCopyCommitIds(rootPath: string): Promise<string[]> {
  try {
    // jj resolves the workspace by walking up from cwd; `-R <path>` does NOT
    // walk up, so a subdirectory invocation with -R would silently yield
    // nothing and disable prune's working-copy sparing.
    const { stdout } = await execFileAsync(
      "jj",
      [
        "--ignore-working-copy",
        "log",
        "-r",
        "working_copies()",
        "--no-graph",
        "-T",
        'commit_id ++ "\\n"',
      ],
      { cwd: rootPath, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const DEV_FAST_NOTES_GLOB = "refs/notes/dev-fast/*";
export const DEV_FAST_REMOTE_NOTES_PREFIX = "refs/notes/dev-fast/remote/";
export const DEV_FAST_NOTES_FETCH_REFSPEC =
  "+refs/notes/dev-fast/*:refs/notes/dev-fast/remote/*";
export const DEV_FAST_NOTES_REMOTE_CONFIG = "devFast.notesRemote";

export async function notesRemote(
  rootPath: string,
  explicitRemote?: string,
): Promise<string> {
  const explicit = explicitRemote?.trim();
  if (explicit) return explicit;
  const configured = await git(
    rootPath,
    ["config", "--get", DEV_FAST_NOTES_REMOTE_CONFIG],
    { allowFailure: true },
  );
  return configured.ok && configured.stdout.trim()
    ? configured.stdout.trim()
    : "origin";
}

export function notesRemoteSync(
  rootPath: string,
  explicitRemote?: string,
): string {
  const explicit = explicitRemote?.trim();
  if (explicit) return explicit;
  try {
    return (
      execFileSync(
        "git",
        gitArgsSync(rootPath, [
          "config",
          "--get",
          DEV_FAST_NOTES_REMOTE_CONFIG,
        ]),
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || "origin"
    );
  } catch {
    return "origin";
  }
}

/** Local notes ref → the remote/* namespace it fetches into. */
export function remoteNotesRef(localRef: string): string {
  return localRef.replace("refs/notes/dev-fast/", DEV_FAST_REMOTE_NOTES_PREFIX);
}

/**
 * Push local dev-fast notes refs to the remote. Notes histories routinely
 * diverge (two teammates flush maps for different commits), so a plain
 * non-fast-forward push would wedge permanently. Instead, per ref:
 *
 *   1. fetch the remote's current tip into the remote/* namespace,
 *   2. compute an entry-level union — per annotated commit, the local entry
 *      wins when both sides have one; remote-only entries are adopted into
 *      the local ref via the locked write path,
 *   3. push with `--force-with-lease=<ref>:<fetched-tip>` so a concurrent
 *      remote update is never clobbered blind; a lease failure re-reconciles
 *      once, then reports softly.
 *
 * Per-entry last-push-wins is the accepted semantic.
 */
export async function pushNotes(input: {
  rootPath: string;
  remote?: string;
  refs: readonly string[];
}): Promise<{ ok: boolean; pushed: string[]; error?: string }> {
  const remote = await notesRemote(input.rootPath, input.remote);
  const pushed: string[] = [];
  const errors: string[] = [];
  for (const ref of input.refs) {
    const resolved = await git(input.rootPath, ["rev-parse", "--verify", ref], {
      allowFailure: true,
    });
    if (!resolved.ok) continue;
    const result = await pushNotesRefReconciled({
      rootPath: input.rootPath,
      remote,
      ref,
    });
    if (result.ok) pushed.push(ref);
    else errors.push(`${ref}: ${result.error}`);
  }
  if (errors.length > 0) {
    return { ok: false, pushed, error: errors.join("; ") };
  }
  return { ok: true, pushed };
}

const PUSH_LEASE_RETRIES = 2; // initial attempt + one lease-failure retry

async function pushNotesRefReconciled(input: {
  rootPath: string;
  remote: string;
  ref: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < PUSH_LEASE_RETRIES; attempt += 1) {
    let remoteTip: string;
    try {
      remoteTip = await reconcileNotesRefWithRemote(input);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const pushed = await git(
      input.rootPath,
      [
        "push",
        // Notes are tool-owned metadata, not source changes. Repository
        // pre-push checks must not block sharing them.
        "--no-verify",
        input.remote,
        `${input.ref}:${input.ref}`,
        // An empty expected tip means "the remote ref must not exist yet".
        `--force-with-lease=${input.ref}:${remoteTip}`,
      ],
      { allowFailure: true },
    );
    if (pushed.ok) return { ok: true };
    const stderr = pushed.stderr.trim();
    const leaseFailed = /stale info|\[rejected\]/i.test(stderr);
    if (!leaseFailed || attempt === PUSH_LEASE_RETRIES - 1) {
      return { ok: false, error: stderr };
    }
  }
  return { ok: false, error: "force-with-lease retry exhausted" };
}

/**
 * Bring the local ref up to an entry-level union with the remote before
 * pushing. Returns the remote tip the push must lease against ("" when the
 * remote does not have the ref yet).
 */
async function reconcileNotesRefWithRemote(input: {
  rootPath: string;
  remote: string;
  ref: string;
}): Promise<string> {
  const listed = await git(
    input.rootPath,
    ["ls-remote", input.remote, input.ref],
    { allowFailure: true },
  );
  if (!listed.ok) {
    throw new Error(
      listed.stderr.trim() ||
        `git ls-remote ${input.remote} ${input.ref} failed`,
    );
  }
  const remoteTip = listed.stdout.split(/\s/, 1)[0]?.trim() ?? "";
  if (!remoteTip) return "";

  const remoteRef = remoteNotesRef(input.ref);
  const fetched = await git(
    input.rootPath,
    ["fetch", input.remote, `+${input.ref}:${remoteRef}`],
    { allowFailure: true },
  );
  if (!fetched.ok) {
    throw new Error(
      fetched.stderr.trim() || `git fetch ${input.remote} ${input.ref} failed`,
    );
  }

  const localCommits = new Set(
    (await listNoteCommits({ rootPath: input.rootPath, ref: input.ref })).map(
      (commit) => commit.toLowerCase(),
    ),
  );
  const remoteCommits = await listNoteCommits({
    rootPath: input.rootPath,
    ref: remoteRef,
  });
  const remoteOnly = remoteCommits.filter(
    (commit) => !localCommits.has(commit.toLowerCase()),
  );
  if (remoteOnly.length > 0) {
    const contents = await readNotesBatch({
      rootPath: input.rootPath,
      ref: remoteRef,
      commits: remoteOnly,
    });
    for (const [commit, content] of contents) {
      // The locked write path: adoption must serialize with local writers.
      await writeNote({
        rootPath: input.rootPath,
        ref: input.ref,
        commit,
        content,
      });
    }
  }
  return remoteTip;
}

/**
 * Fetch teammates' dev-fast notes into the remote/* namespace. Honors the
 * `devFast.fetchNotes` git config kill-switch: when it parses to false the
 * fetch is skipped without touching the network and the result reports
 * `skipped: true`. Unset (or unparseable) config fetches as usual.
 */
export async function fetchNotes(input: {
  rootPath: string;
  remote?: string;
  /** Aborting kills the underlying git fetch process (no orphaned fetch). */
  signal?: AbortSignal;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (await notesFetchDisabled(input.rootPath)) {
    return { ok: true, skipped: true };
  }
  const remote = await notesRemote(input.rootPath, input.remote);
  const fetched = await git(
    input.rootPath,
    ["fetch", remote, DEV_FAST_NOTES_FETCH_REFSPEC],
    { allowFailure: true, signal: input.signal },
  );
  return fetched.ok
    ? { ok: true }
    : { ok: false, error: fetched.stderr.trim() };
}

export async function notesFetchDisabled(rootPath: string): Promise<boolean> {
  // --type=bool normalizes git's boolean spellings (false/0/no/off); an unset
  // or unparseable value fails the lookup and keeps fetching enabled.
  const config = await git(
    rootPath,
    ["config", "--type=bool", "--get", "devFast.fetchNotes"],
    { allowFailure: true },
  );
  return config.ok && config.stdout.trim() === "false";
}

export function notesFetchDisabledSync(rootPath: string): boolean {
  try {
    return (
      execFileSync(
        "git",
        gitArgsSync(rootPath, [
          "config",
          "--type=bool",
          "--get",
          "devFast.fetchNotes",
        ]),
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() === "false"
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const notesConfigEnsured = new Set<string>();

/**
 * Idempotently configure a repo for dev-fast notes:
 * - notes.rewriteRef / notes.rewriteMode so git-native rebases and amends
 *   carry notes forward,
 * - a fetch refspec on the selected notes remote so ordinary fetches receive
 *   teammates' notes into the remote/* namespace.
 */
export async function ensureNotesConfig(input: {
  rootPath: string;
}): Promise<void> {
  const gitDir = await gitCommonDir(input.rootPath);
  if (!gitDir) return;
  const remote = await notesRemote(input.rootPath);
  const cacheKey = `${gitDir}\0${remote}`;
  if (notesConfigEnsured.has(cacheKey)) return;

  const rewriteRef = await git(
    input.rootPath,
    ["config", "--get-all", "notes.rewriteRef"],
    { allowFailure: true },
  );
  if (!rewriteRef.stdout.split("\n").includes(DEV_FAST_NOTES_GLOB)) {
    await git(
      input.rootPath,
      ["config", "--add", "notes.rewriteRef", DEV_FAST_NOTES_GLOB],
      { allowFailure: true },
    );
  }
  await git(input.rootPath, ["config", "notes.rewriteMode", "overwrite"], {
    allowFailure: true,
  });

  // The devFast.fetchNotes kill-switch also gates *installing* the fetch
  // refspec, or every ordinary `git fetch` would keep pulling notes despite
  // the switch. Don't memoize while disabled: flipping the switch back on
  // must let a later call install the refspec.
  if (await notesFetchDisabled(input.rootPath)) return;
  notesConfigEnsured.add(cacheKey);

  const remoteFetch = await git(
    input.rootPath,
    ["config", "--get-all", `remote.${remote}.fetch`],
    { allowFailure: true },
  );
  if (
    remoteFetch.ok &&
    !remoteFetch.stdout.split("\n").includes(DEV_FAST_NOTES_FETCH_REFSPEC)
  ) {
    await git(
      input.rootPath,
      [
        "config",
        "--add",
        `remote.${remote}.fetch`,
        DEV_FAST_NOTES_FETCH_REFSPEC,
      ],
      { allowFailure: true },
    );
  }
}

export function ensureNotesConfigSync(input: { rootPath: string }): void {
  const gitDir = gitCommonDirSync(input.rootPath);
  if (!gitDir) return;
  const remote = notesRemoteSync(input.rootPath);
  const cacheKey = `${gitDir}\0${remote}`;
  if (notesConfigEnsured.has(cacheKey)) return;
  const config = (args: string[]) => {
    try {
      return execFileSync(
        "git",
        gitArgsSync(input.rootPath, ["config", ...args]),
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      return "";
    }
  };
  if (
    !config(["--get-all", "notes.rewriteRef"])
      .split("\n")
      .includes(DEV_FAST_NOTES_GLOB)
  ) {
    config(["--add", "notes.rewriteRef", DEV_FAST_NOTES_GLOB]);
  }
  config(["notes.rewriteMode", "overwrite"]);
  // See ensureNotesConfig: skip refspec install (and memoization) while the
  // kill-switch is on.
  if (notesFetchDisabledSync(input.rootPath)) return;
  notesConfigEnsured.add(cacheKey);
  const remoteFetch = config(["--get-all", `remote.${remote}.fetch`]);
  if (
    remoteFetch.trim() !== "" &&
    !remoteFetch.split("\n").includes(DEV_FAST_NOTES_FETCH_REFSPEC)
  ) {
    config(["--add", `remote.${remote}.fetch`, DEV_FAST_NOTES_FETCH_REFSPEC]);
  }
}

/** Test hook: config idempotence is tracked per git dir for the process. */
export function clearNotesConfigCacheForTests(): void {
  notesConfigEnsured.clear();
}

// ---------------------------------------------------------------------------
// jj evolog (rewrite recovery)
// ---------------------------------------------------------------------------

/**
 * The commit ids a change has occupied, newest first (the current commit is
 * the first entry). Used for read-time note recovery after jj rewrites: the
 * newest predecessor with a note is the note's rightful heir.
 */
export async function evologCommitIds(input: {
  rootPath: string;
  ref: string;
}): Promise<string[]> {
  // The evolog template context changed across jj versions: newer versions
  // expose the entry's commit as `commit`, older ones used the plain commit
  // keywords. Try both.
  for (const template of [
    'commit.commit_id() ++ "\\n"',
    'commit_id ++ "\\n"',
  ]) {
    try {
      // cwd-based invocation (no -R): jj walks up from cwd, so subdirectory
      // roots still resolve to the enclosing workspace.
      const { stdout } = await execFileAsync(
        "jj",
        [
          "--ignore-working-copy",
          "evolog",
          "-r",
          input.ref,
          "--no-graph",
          "-T",
          template,
        ],
        { cwd: input.rootPath, maxBuffer: 8 * 1024 * 1024 },
      );
      const ids = [
        ...new Set(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      if (ids.length > 0) return ids;
    } catch {
      // Try the next template form.
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Locking (mirrors the graph-build lock: stale/dead-pid locks are reclaimed)
// ---------------------------------------------------------------------------

async function withNotesLock<T>(
  rootPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const gitDir = await gitCommonDir(rootPath);
  if (!gitDir) throw new Error(`No git repository found at ${rootPath}`);
  const lockPath = notesLockPath(gitDir);
  return await withFileLock(
    {
      createTimeoutError: (_path, waitedMs) =>
        new NotesLockTimeoutError(lockPath, waitedMs),
      lockPath,
      pollMs: NOTES_LOCK_POLL_MS,
      staleMs: NOTES_LOCK_STALE_MS,
      timeoutMs: notesLockTimeoutMs(),
      updateMs: NOTES_LOCK_TOUCH_MS,
    },
    fn,
  );
}

function withNotesLockSync<T>(rootPath: string, fn: () => T): T {
  const gitDir = gitCommonDirSync(rootPath);
  if (!gitDir) throw new Error(`No git repository found at ${rootPath}`);
  const lockPath = notesLockPath(gitDir);
  const timeoutMs = notesLockSyncTimeoutMs();
  return withFileLockSync(
    {
      createTimeoutError: (_path, waitedMs) =>
        new NotesLockTimeoutError(lockPath, waitedMs),
      lockPath,
      pollMs: NOTES_LOCK_POLL_MS,
      staleMs: NOTES_LOCK_STALE_MS,
      timeoutMs,
      updateMs: NOTES_LOCK_TOUCH_MS,
    },
    fn,
  );
}

// Test hooks: the timeouts are process-wide but overridable so lock-failure
// paths can be exercised without minute-long waits.
let notesLockTimeoutOverrideMs: number | null = null;
let notesLockSyncTimeoutOverrideMs: number | null = null;

function notesLockTimeoutMs(): number {
  return notesLockTimeoutOverrideMs ?? NOTES_LOCK_TIMEOUT_MS;
}

function notesLockSyncTimeoutMs(): number {
  return notesLockSyncTimeoutOverrideMs ?? NOTES_LOCK_SYNC_TIMEOUT_MS;
}

export function setNotesLockTimeoutsForTests(
  overrides: { asyncMs?: number; syncMs?: number } | null,
): void {
  notesLockTimeoutOverrideMs = overrides?.asyncMs ?? null;
  notesLockSyncTimeoutOverrideMs = overrides?.syncMs ?? null;
}

export function notesLockPathForTests(gitDir: string): string {
  return notesLockPath(gitDir);
}

function notesLockPath(gitDir: string): string {
  const dir = path.join(gitDir, "dev-fast");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "notes.lock");
}
