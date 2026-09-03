import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import gitUrlParse from "git-url-parse";

const execFileAsync = promisify(execFile);
const LOCAL_GIT_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

type CommandOutputOptions = {
  cwd?: string;
  maxBuffer?: number;
  trim?: boolean;
};

export type LocalVcsKind = "jj" | "git";

export interface LocalVcs {
  kind: LocalVcsKind;
  rootPath: string;
  currentHead(): Promise<ResolvedRevision | null>;
  resolveRevision(revision: string): Promise<ResolvedRevision | null>;
  defaultBranch(): Promise<ResolvedRevision | null>;
  mergeBase(baseRef: string, headRef: string): Promise<ResolvedRevision | null>;
  listTrackedFiles(revision?: string): Promise<string[]>;
  readFileAtRef(ref: string, relativePath: string): Promise<string | null>;
  diff(input: {
    base: string;
    head?: string;
    format: "git";
    contextLines?: number;
    paths?: string[];
  }): Promise<string>;
  diffNameStatus(input: {
    base: string;
    head: string;
    mergeBase?: boolean;
  }): Promise<NameStatus[]>;
  diffFileSummaries(input: {
    base: string;
    head?: string;
    paths?: string[];
  }): Promise<LocalVcsDiffFileSummary[]>;
  githubRemoteSlug(): Promise<string | null>;
}

export interface ResolvedRevision {
  commit: string;
}

export interface DiffNameStatus {
  changedFiles: string[];
  deletedFiles: string[];
}

export interface NameStatus {
  path: string;
  status: "modified" | "deleted";
}

export interface LocalVcsDiffFileSummary {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface LocalVcsCommitSummary {
  commit: string;
  parentCommit: string;
  subject: string;
  author: string;
  authoredAt: string;
  fileCount: number;
  additions: number;
  deletions: number;
}

export async function detectLocalVcs(
  rootPath: string,
): Promise<LocalVcs | null> {
  const resolvedRootPath = canonicalPath(rootPath);
  const jjRoot = await commandOutput(
    "jj",
    ["-R", resolvedRootPath, "root", "--ignore-working-copy"],
    { cwd: resolvedRootPath },
  ).catch(() => null);
  if (jjRoot && isInsideDirectory(resolvedRootPath, canonicalPath(jjRoot))) {
    return createLocalVcs("jj", canonicalPath(jjRoot));
  }

  const gitRoot = await commandOutput(
    "git",
    ["-C", resolvedRootPath, "rev-parse", "--show-toplevel"],
    { cwd: resolvedRootPath },
  ).catch(() => null);
  if (gitRoot) return createLocalVcs("git", canonicalPath(gitRoot));
  return null;
}

export function detectLocalVcsSync(rootPath: string): LocalVcs | null {
  const resolvedRootPath = canonicalPath(rootPath);
  const jjRoot = commandOutputSync(
    "jj",
    ["-R", resolvedRootPath, "root", "--ignore-working-copy"],
    { cwd: resolvedRootPath },
  );
  if (jjRoot && isInsideDirectory(resolvedRootPath, canonicalPath(jjRoot))) {
    return createLocalVcs("jj", canonicalPath(jjRoot));
  }

  const gitRoot = commandOutputSync(
    "git",
    ["-C", resolvedRootPath, "rev-parse", "--show-toplevel"],
    { cwd: resolvedRootPath },
  );
  if (gitRoot) return createLocalVcs("git", canonicalPath(gitRoot));
  return null;
}

// ---------------------------------------------------------------------------
// Shared git directory resolution
// ---------------------------------------------------------------------------

export interface RepoContext {
  commonDir: string;
  originUrl: string | null;
  githubSlug: string | null;
}

/**
 * Resolve the repository's shared git directory ($GIT_COMMON_DIR) so all
 * worktrees agree on one object database and one refs namespace. Follows the
 * same jj-first preference as detectLocalVcs: a non-colocated jj workspace
 * nested inside another git repo must resolve to its jj backing store
 * (`jj git root`), not the OUTER repo's git dir via plain git. Colocated jj
 * repos have a real .git and resolve to it through either path.
 */
export async function gitCommonDir(rootPath: string): Promise<string | null> {
  const key = path.resolve(rootPath);
  // cwd-based jj invocation, never `-R`: jj walks UP from cwd like git does,
  // while `-R <subdir>` fails outright for a subdirectory of a workspace and
  // would silently fall through to git's cwd walk — which, from a
  // non-colocated jj workspace nested in another git repo, resolves the
  // OUTER repo's git dir.
  const resolved =
    (await commandOutput("jj", ["git", "root", "--ignore-working-copy"], {
      cwd: key,
    }).catch(() => null)) ||
    (await commandOutput(
      "git",
      ["-C", key, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: key },
    ).catch(() => null)) ||
    null;
  return resolved;
}

export function gitCommonDirSync(rootPath: string): string | null {
  const key = path.resolve(rootPath);
  const resolved =
    commandOutputSync("jj", ["git", "root", "--ignore-working-copy"], {
      cwd: key,
    }) ||
    commandOutputSync(
      "git",
      ["-C", key, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: key },
    ) ||
    null;
  return resolved;
}

/**
 * Resolve the repository identity through its jj-first shared Git directory.
 * Remote lookup must never rely on Git's cwd walk: a non-colocated jj
 * workspace may be nested inside an unrelated Git repository.
 */
export async function resolveRepoContext(
  rootPath: string,
): Promise<RepoContext | null> {
  const key = path.resolve(rootPath);

  const commonDir = await gitCommonDir(key);
  if (!commonDir) return null;
  const [originUrl, resolvedOriginUrl] = await Promise.all([
    commandOutput("git", [
      "--git-dir",
      commonDir,
      "config",
      "--get",
      "remote.origin.url",
    ]).catch(() => null),
    commandOutput("git", [
      "--git-dir",
      commonDir,
      "remote",
      "get-url",
      "origin",
    ]).catch(() => null),
  ]);
  const context = {
    commonDir,
    originUrl: originUrl || null,
    githubSlug:
      (resolvedOriginUrl ? parseGitRemoteSlug(resolvedOriginUrl) : null) ??
      (originUrl ? parseGitRemoteSlug(originUrl) : null),
  };
  return context;
}

export function resolveRepoContextSync(rootPath: string): RepoContext | null {
  const key = path.resolve(rootPath);

  const commonDir = gitCommonDirSync(key);
  if (!commonDir) return null;
  const originUrl =
    commandOutputSync("git", [
      "--git-dir",
      commonDir,
      "config",
      "--get",
      "remote.origin.url",
    ]) || null;
  const resolvedOriginUrl =
    commandOutputSync("git", [
      "--git-dir",
      commonDir,
      "remote",
      "get-url",
      "origin",
    ]) || null;
  const context = {
    commonDir,
    originUrl,
    githubSlug:
      (resolvedOriginUrl ? parseGitRemoteSlug(resolvedOriginUrl) : null) ??
      (originUrl ? parseGitRemoteSlug(originUrl) : null),
  };
  return context;
}

/** Git argv prefix that pins a command to the repo's shared git dir. */
export async function gitArgs(
  rootPath: string,
  args: string[],
): Promise<string[]> {
  const gitDir = await gitCommonDir(rootPath);
  if (!gitDir) throw new Error(`No git repository found at ${rootPath}`);
  return ["--git-dir", gitDir, ...args];
}

export function gitArgsSync(rootPath: string, args: string[]): string[] {
  const gitDir = gitCommonDirSync(rootPath);
  if (!gitDir) throw new Error(`No git repository found at ${rootPath}`);
  return ["--git-dir", gitDir, ...args];
}

/** Run git against the repo's shared git dir, optionally tolerating failure. */
export async function git(
  rootPath: string,
  args: string[],
  options: { allowFailure?: boolean; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      await gitArgs(rootPath, args),
      { maxBuffer: 64 * 1024 * 1024, signal: options.signal },
    );
    return { ok: true, stdout, stderr };
  } catch (error) {
    if (options.allowFailure) {
      const err = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(error),
      };
    }
    throw error;
  }
}

function createLocalVcs(kind: LocalVcsKind, rootPath: string): LocalVcs {
  return {
    kind,
    rootPath,
    currentHead: () => currentHeadForKind(rootPath, kind),
    resolveRevision: (revision) =>
      resolveRevisionForKind(rootPath, revision, kind),
    defaultBranch: () => defaultBranchForKind(rootPath, kind),
    mergeBase: (baseRef, headRef) =>
      mergeBaseForKind({
        rootPath,
        baseRef,
        headRef,
        kind,
      }),
    listTrackedFiles: (revision) =>
      Promise.resolve(
        listTrackedFilesForKind({ rootPath, ref: revision, kind }),
      ),
    readFileAtRef: (ref, relativePath) =>
      Promise.resolve(
        readFileAtRevisionForKind({
          rootPath,
          ref,
          relativePath,
          kind,
        })?.source ?? null,
      ),
    diff: (input) =>
      diffForKind({
        rootPath,
        baseRef: input.base,
        headRef: input.head,
        contextLines: input.contextLines,
        paths: input.paths,
        kind,
      }),
    diffNameStatus: async (input) =>
      toNameStatusEntries(
        await diffNameStatusForKind({
          rootPath,
          baseRef: input.base,
          headRef: input.head,
          mergeBase: input.mergeBase,
          kind,
        }),
      ),
    diffFileSummaries: (input) =>
      diffFileSummariesForKind({
        rootPath,
        baseRef: input.base,
        headRef: input.head,
        paths: input.paths,
        kind,
      }),
    githubRemoteSlug: () => githubRemoteSlug(rootPath),
  };
}

export async function currentHead(
  rootPath: string,
): Promise<ResolvedRevision | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (!vcs) return null;
  return vcs.currentHead();
}

export interface LocalChangeIdentity {
  kind: "jj-bookmark" | "jj-change" | "git-branch" | "git-commit";
  name: string;
}

/**
 * The durable name of the checked-out unit of change, preferring names humans
 * gave it: the current git branch; a local jj bookmark on the subject change;
 * else the subject change id. The subject is `@`, or `@-` when `@` is an
 * empty, undescribed scratch child (the usual jj working style). Null when no
 * such name exists (a detached git HEAD, or no repository) — positional refs
 * like `@` or `HEAD` are not identities.
 */
export async function currentChangeIdentity(
  rootPath: string,
): Promise<LocalChangeIdentity | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (!vcs) return null;
  if (vcs.kind === "jj") {
    const at = await jjChangeSummary(rootPath, "@");
    if (at.length !== 1) return null;
    let subject = at[0]!;
    if (subject.scratch) {
      const parents = await jjChangeSummary(rootPath, "@-");
      if (parents.length === 1) subject = parents[0]!;
    }
    const bookmark = subject.bookmarks[0];
    if (bookmark) return { kind: "jj-bookmark", name: bookmark };
    return subject.changeId
      ? { kind: "jj-change", name: subject.changeId }
      : null;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", rootPath, "symbolic-ref", "--short", "-q", "HEAD"],
      {},
    ));
  } catch (error) {
    if ((error as { code?: number }).code === 1) return null;
    throw error;
  }
  const branch = stdout.trim();
  return branch ? { kind: "git-branch", name: branch } : null;
}

/** Resolve one revision to its durable review identity. */
export async function changeIdentityForRevision(
  rootPath: string,
  revision: string,
): Promise<LocalChangeIdentity | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (!vcs) return null;
  if (vcs.kind === "git") {
    const resolved = await vcs.resolveRevision(revision);
    if (!resolved) return null;
    const branch = await gitRevisionBranch(rootPath, revision);
    return branch
      ? { kind: "git-branch", name: branch }
      : { kind: "git-commit", name: resolved.commit };
  }
  const summaries = await jjChangeSummary(rootPath, revision);
  if (summaries.length === 1) {
    const subject = summaries[0]!;
    const bookmark = subject.bookmarks[0];
    if (bookmark) return { kind: "jj-bookmark", name: bookmark };
    return subject.changeId
      ? { kind: "jj-change", name: subject.changeId }
      : null;
  }
  if (summaries.length > 1 || !canUseGitFallbackSync(rootPath, vcs.kind)) {
    return null;
  }

  // A colocated repository can contain a Git commit that jj has not imported,
  // such as an exact pull-request SHA with no local ref. The commit is still a
  // valid immutable Review binding. Do not substitute the current jj change.
  const resolved = await resolveGitRevisionCommit(rootPath, revision).catch(
    () => null,
  );
  return resolved ? { kind: "git-commit", name: resolved } : null;
}

async function gitRevisionBranch(
  rootPath: string,
  revision: string,
): Promise<string | null> {
  const symbolic = await commandOutput("git", [
    "-C",
    rootPath,
    "rev-parse",
    "--symbolic-full-name",
    revision,
  ]).catch(() => "");
  for (const prefix of ["refs/heads/", "refs/remotes/"]) {
    if (symbolic.startsWith(prefix)) return symbolic.slice(prefix.length);
  }
  return null;
}

interface JjChangeSummary {
  changeId: string;
  bookmarks: string[];
  scratch: boolean;
}

async function jjChangeSummary(
  rootPath: string,
  revset: string,
): Promise<JjChangeSummary[]> {
  const template =
    'change_id ++ "\\t" ++ bookmarks.join(",") ++ "\\t" ++ if(empty && description == "", "scratch", "subject") ++ "\\n"';
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "jj",
      [
        "log",
        "-r",
        revset,
        "--no-graph",
        "-T",
        template,
        "--ignore-working-copy",
      ],
      { cwd: rootPath },
    ));
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [changeId, bookmarks, kind] = line.split("\t");
      return {
        changeId: changeId?.trim() ?? "",
        bookmarks: (bookmarks ?? "")
          .split(",")
          .map((name) => name.replace(/[*?]+$/, "").trim())
          .filter((name) => name && !name.includes("@")),
        scratch: kind?.trim() === "scratch",
      };
    });
}

/**
 * Whether a revision carries unresolved jj conflicts. jj materializes
 * conflict markers into the git export of such commits, so a downstream git
 * checkout would silently contain marker text instead of code. Returns null
 * when the repository is not jj (git commits cannot be conflicted) or when
 * jj cannot answer — callers must only act on a definite true.
 */
export async function jjRevisionIsConflicted(
  rootPath: string,
  revision: string,
): Promise<boolean | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (vcs?.kind !== "jj") return null;
  try {
    const { stdout } = await execFileAsync(
      "jj",
      [
        "log",
        "-r",
        revision,
        "--no-graph",
        "-T",
        'if(conflict, "true", "false")',
        "--ignore-working-copy",
      ],
      { cwd: rootPath },
    );
    const value = stdout.trim();
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

export function currentHeadSync(rootPath: string): ResolvedRevision | null {
  const vcs = detectLocalVcsSync(rootPath);
  if (!vcs) return null;
  return currentHeadForKindSync(rootPath, vcs.kind);
}

export async function resolveRevision(
  rootPath: string,
  revision: string,
): Promise<ResolvedRevision | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (!vcs) return null;
  return vcs.resolveRevision(revision);
}

export function resolveRevisionSync(
  rootPath: string,
  revision: string,
): ResolvedRevision | null {
  const vcs = detectLocalVcsSync(rootPath);
  if (!vcs) return null;
  return resolveRevisionForKindSync(rootPath, revision, vcs.kind);
}

export async function defaultBranch(
  rootPath: string,
): Promise<ResolvedRevision | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (!vcs) return null;
  return vcs.defaultBranch();
}

export async function mergeBase(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
}): Promise<ResolvedRevision | null> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) return null;
  return vcs.mergeBase(input.baseRef, input.headRef);
}

export async function defaultBase(input: {
  rootPath: string;
  headRef: string;
}): Promise<ResolvedRevision | null> {
  const base = await defaultBranch(input.rootPath);
  if (!base) return null;
  return mergeBase({
    rootPath: input.rootPath,
    baseRef: base.commit,
    headRef: input.headRef,
  });
}

async function currentHeadForKind(
  rootPath: string,
  kind: LocalVcsKind,
): Promise<ResolvedRevision | null> {
  return resolveRevisionForKind(rootPath, kind === "jj" ? "@" : "HEAD", kind);
}

function currentHeadForKindSync(
  rootPath: string,
  kind: LocalVcsKind,
): ResolvedRevision | null {
  return resolveRevisionForKindSync(
    rootPath,
    kind === "jj" ? "@" : "HEAD",
    kind,
  );
}

async function resolveRevisionForKind(
  rootPath: string,
  revision: string,
  kind: LocalVcsKind,
): Promise<ResolvedRevision | null> {
  const commit = await resolveRevisionCommitByPreference(
    rootPath,
    revision,
    kind,
  );
  return commit ? { commit } : null;
}

function resolveRevisionForKindSync(
  rootPath: string,
  revision: string,
  kind: LocalVcsKind,
): ResolvedRevision | null {
  const commit = resolveRevisionCommitByPreferenceSync(
    rootPath,
    revision,
    kind,
  );
  return commit ? { commit } : null;
}

/**
 * The default branch as a re-resolvable NAME (e.g. "origin/main" or "main"),
 * or null when no candidate resolves. Callers that must store a base ref a
 * later update can re-derive from should prefer this over the resolved
 * commit, which freezes the fork point forever.
 */
export async function defaultBranchRef(
  rootPath: string,
): Promise<string | null> {
  const vcs = await detectLocalVcs(rootPath);
  if (!vcs) return null;
  const candidates = await defaultBranchCandidates(vcs.rootPath);
  for (const candidate of candidates) {
    const commit = await resolveRevisionCommitByPreference(
      vcs.rootPath,
      candidate,
      vcs.kind,
    );
    if (commit) return candidate;
  }
  return null;
}

/**
 * The repo's `devfast.prepare` commands, in configuration order. The key is
 * multi-valued: each value is one opaque shell command that installs the
 * dependencies a materialized tree needs (e.g. `pnpm install`, `uv sync`).
 * The read goes through the shared git dir, so every worktree of the repo —
 * including jj workspaces through their backing git dir — sees one setting.
 * A repo with no configuration returns an empty list.
 */
export async function devfastPrepareCommands(
  rootPath: string,
): Promise<string[]> {
  const result = await git(
    rootPath,
    ["config", "--get-all", "devfast.prepare"],
    { allowFailure: true },
  ).catch(() => null);
  if (!result?.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function defaultBranchForKind(
  rootPath: string,
  kind: LocalVcsKind,
): Promise<ResolvedRevision | null> {
  const candidates = await defaultBranchCandidates(rootPath);
  for (const candidate of candidates) {
    const commit = await resolveRevisionCommitByPreference(
      rootPath,
      candidate,
      kind,
    );
    if (commit) return { commit };
  }
  return null;
}

async function mergeBaseForKind(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
  kind: LocalVcsKind;
}): Promise<ResolvedRevision | null> {
  const commit = await mergeBaseByPreference(
    input.rootPath,
    input.baseRef,
    input.headRef,
    input.kind,
  );
  // No guessing: disjoint histories have no merge base, and callers must see
  // that as null rather than a silently substituted default branch.
  return commit ? { commit } : null;
}

export function listTrackedFilesSync(input: {
  rootPath: string;
  ref?: string;
}): string[] {
  const vcs = detectLocalVcsSync(input.rootPath);
  if (!vcs) return [];
  return listTrackedFilesForKind({
    rootPath: vcs.rootPath,
    ref: input.ref,
    kind: vcs.kind,
  });
}

function listTrackedFilesForKind(input: {
  rootPath: string;
  ref?: string;
  kind: LocalVcsKind;
}): string[] {
  if (input.kind === "jj") {
    const args = [
      "-R",
      input.rootPath,
      "file",
      "list",
      "--ignore-working-copy",
    ];
    if (input.ref) args.push("-r", input.ref);
    const output = commandOutputSync("jj", args, { cwd: input.rootPath });
    if (output !== null) return splitLines(output);
    if (!canUseGitFallbackSync(input.rootPath, input.kind)) return [];
  }

  const output = input.ref
    ? commandOutputSync(
        "git",
        ["-C", input.rootPath, "ls-tree", "-r", "-z", "--name-only", input.ref],
        { cwd: input.rootPath },
      )
    : commandOutputSync("git", ["-C", input.rootPath, "ls-files", "-z"], {
        cwd: input.rootPath,
      });
  if (output === null) return [];
  return output.split("\0").filter(Boolean);
}

export function readFileAtRevisionSync(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
}): { commit: string; source: string } | null {
  const vcs = detectLocalVcsSync(input.rootPath);
  if (!vcs) return null;
  return readFileAtRevisionForKind({
    ...input,
    rootPath: vcs.rootPath,
    kind: vcs.kind,
  });
}

export async function readFileAtRevision(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
}): Promise<{ commit: string; source: string } | null> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) return null;
  return readFileAtRevisionForKindAsync({
    ...input,
    rootPath: vcs.rootPath,
    kind: vcs.kind,
  });
}

function readFileAtRevisionForKind(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
  kind: LocalVcsKind;
}): { commit: string; source: string } | null {
  return input.kind === "jj"
    ? (readJjFileAtRevisionSync(input) ??
        (canUseGitFallbackSync(input.rootPath, input.kind)
          ? readGitFileAtRevisionSync(input)
          : null))
    : (readGitFileAtRevisionSync(input) ?? readJjFileAtRevisionSync(input));
}

async function readFileAtRevisionForKindAsync(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
  kind: LocalVcsKind;
}): Promise<{ commit: string; source: string } | null> {
  if (input.kind === "jj") {
    return (
      (await readJjFileAtRevision(input).catch(() => null)) ??
      (canUseGitFallbackSync(input.rootPath, input.kind)
        ? await readGitFileAtRevision(input).catch(() => null)
        : null)
    );
  }
  return (
    (await readGitFileAtRevision(input).catch(() => null)) ??
    (canUseGitFallbackSync(input.rootPath, input.kind)
      ? await readJjFileAtRevision(input).catch(() => null)
      : null)
  );
}

export async function diff(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  contextLines?: number;
  nameOnly?: boolean;
  paths?: string[];
}): Promise<string> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  return diffForKind({ ...input, rootPath: vcs.rootPath, kind: vcs.kind });
}

/** Compare two exact Git trees without merge-base semantics. */
export async function diffTrees(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
  contextLines?: number;
  paths?: string[];
}): Promise<string> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  return diffForKind({
    ...input,
    rootPath: vcs.rootPath,
    kind: vcs.kind,
    mergeBase: false,
  });
}

export async function diffFileSummaries(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  paths?: string[];
}): Promise<LocalVcsDiffFileSummary[]> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  return diffFileSummariesForKind({
    ...input,
    rootPath: vcs.rootPath,
    kind: vcs.kind,
  });
}

/** List commits in base..head order, newest first, with first-parent stats. */
export async function listCommitRange(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
}): Promise<LocalVcsCommitSummary[]> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        vcs.rootPath,
        "log",
        "--topo-order",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00",
        "--numstat",
        "-z",
        `${input.baseRef}..${input.headRef}`,
      ],
      { cwd: vcs.rootPath, maxBuffer: 25 * 1024 * 1024 },
    );
    return parseGitCommitRange(stdout);
  } catch (error) {
    if (vcs.kind !== "jj") throw error;
    return readJjCommitRange(vcs.rootPath, input.baseRef, input.headRef);
  }
}

function parseGitCommitRange(output: string): LocalVcsCommitSummary[] {
  const fields = output.split("\0");
  const commits: LocalVcsCommitSummary[] = [];
  let index = 0;
  while (index < fields.length) {
    const commit = fields[index++]?.replace(/^\n+/u, "") ?? "";
    if (!/^[0-9a-f]{40}$/iu.test(commit)) continue;
    const parentCommit = (fields[index++] ?? "").split(" ")[0] ?? "";
    const author = fields[index++] ?? "";
    const authoredAt = fields[index++] ?? "";
    const subject = fields[index++] ?? "";
    if (fields[index] === "") index += 1;
    let fileCount = 0;
    let additions = 0;
    let deletions = 0;
    while (index < fields.length) {
      const field = fields[index]?.replace(/^\n+/u, "") ?? "";
      if (/^[0-9a-f]{40}$/iu.test(field)) break;
      index += 1;
      if (!field) continue;
      const [rawAdditions, rawDeletions, filePath] = field.split("\t");
      if (rawDeletions === undefined) continue;
      fileCount += 1;
      additions += parseGitNumStatCount(rawAdditions);
      deletions += parseGitNumStatCount(rawDeletions);
      if (!filePath) index += 2;
    }
    if (!parentCommit || !authoredAt) continue;
    commits.push({
      commit,
      parentCommit,
      subject,
      author,
      authoredAt,
      fileCount,
      additions,
      deletions,
    });
  }
  return commits;
}

async function readJjCommitRange(
  rootPath: string,
  baseRef: string,
  headRef: string,
): Promise<LocalVcsCommitSummary[]> {
  const output = await commandOutput(
    "jj",
    [
      "-R",
      rootPath,
      "--no-pager",
      "log",
      "--no-graph",
      "-r",
      `::${headRef} ~ ::${baseRef}`,
      "-T",
      'commit_id ++ "\\0" ++ parents.map(|p| p.commit_id()).join(" ") ++ "\\0" ++ author.name() ++ "\\0" ++ author.timestamp().format("%+") ++ "\\0" ++ description.first_line() ++ "\\0"',
      "--ignore-working-copy",
    ],
    { cwd: rootPath, maxBuffer: 25 * 1024 * 1024, trim: false },
  );
  const fields = output.split("\0");
  const metadata: Array<
    Omit<LocalVcsCommitSummary, "fileCount" | "additions" | "deletions">
  > = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const commit = fields[index]?.trim() ?? "";
    const parentCommit = (fields[index + 1] ?? "").split(" ")[0] ?? "";
    if (!commit || !parentCommit) continue;
    metadata.push({
      commit,
      parentCommit,
      author: fields[index + 2] ?? "",
      authoredAt: fields[index + 3] ?? "",
      subject: fields[index + 4] ?? "",
    });
  }
  return Promise.all(
    metadata.map(async (entry) => {
      const files = await diffFileSummariesForKind({
        rootPath,
        baseRef: entry.parentCommit,
        headRef: entry.commit,
        mergeBase: false,
        kind: "jj",
      });
      return {
        ...entry,
        fileCount: files.length,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
      } satisfies LocalVcsCommitSummary;
    }),
  );
}

/** Summarize changes between two exact Git trees. */
export async function diffFileSummariesTrees(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
  paths?: string[];
}): Promise<LocalVcsDiffFileSummary[]> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  return diffFileSummariesForKind({
    ...input,
    rootPath: vcs.rootPath,
    kind: vcs.kind,
    mergeBase: false,
  });
}

async function diffForKind(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  contextLines?: number;
  nameOnly?: boolean;
  paths?: string[];
  mergeBase?: boolean;
  kind: LocalVcsKind;
}): Promise<string> {
  if (input.kind === "jj") {
    return readJjDiff(input).catch((error: unknown) => {
      if (!canUseGitFallbackSync(input.rootPath, input.kind)) throw error;
      return readGitDiff(input);
    });
  }
  return readGitDiff(input).catch(() => readJjDiff(input));
}

async function diffFileSummariesForKind(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  paths?: string[];
  mergeBase?: boolean;
  kind: LocalVcsKind;
}): Promise<LocalVcsDiffFileSummary[]> {
  const requestedPaths = normalizeDiffPaths(input.paths);
  const unfilteredInput = { ...input, paths: undefined };
  let summaries: LocalVcsDiffFileSummary[];
  if (input.kind === "jj") {
    if (canUseGitFallbackSync(input.rootPath, input.kind)) {
      try {
        summaries = await readGitDiffFileSummaries(unfilteredInput);
        return filterDiffFileSummaries(summaries, requestedPaths);
      } catch {
        // jj-only revisions are not always addressable by colocated Git.
      }
    }
    summaries = parseGitPatchFileSummaries(await readJjDiff(unfilteredInput));
    return filterDiffFileSummaries(summaries, requestedPaths);
  }
  summaries = await readGitDiffFileSummaries(unfilteredInput).catch(async () =>
    parseGitPatchFileSummaries(await readJjDiff(unfilteredInput)),
  );
  return filterDiffFileSummaries(summaries, requestedPaths);
}

export async function diffNameStatus(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
  mergeBase?: boolean;
}): Promise<DiffNameStatus> {
  const vcs = await detectLocalVcs(input.rootPath);
  if (!vcs) {
    throw new Error(`No Git or jj repository found for ${input.rootPath}.`);
  }
  return diffNameStatusForKind({
    ...input,
    rootPath: vcs.rootPath,
    kind: vcs.kind,
  });
}

export async function diffNameStatusTrees(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
}): Promise<DiffNameStatus> {
  return diffNameStatus({ ...input, mergeBase: false });
}

async function diffNameStatusForKind(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
  mergeBase?: boolean;
  kind: LocalVcsKind;
}): Promise<DiffNameStatus> {
  if (input.kind === "jj") {
    return readJjDiffNameStatus(input).catch((error: unknown) => {
      if (!canUseGitFallbackSync(input.rootPath, input.kind)) throw error;
      return readGitDiffNameStatus(input);
    });
  }
  return readGitDiffNameStatus(input).catch(() => readJjDiffNameStatus(input));
}

export async function githubRemoteSlug(
  rootPath: string,
): Promise<string | null> {
  return (await resolveRepoContext(rootPath))?.githubSlug ?? null;
}

export interface ParsedGitRemote {
  protocol: string;
  host: string;
  port: number | null;
  owner: string;
  repo: string;
  slug: string;
}

export function parseGitRemote(remote: string): ParsedGitRemote | null {
  const value = remote.trim();
  if (!value) return null;

  try {
    const parsed = gitUrlParse(value);
    const host = parsed.resource.trim().toLowerCase();
    const owner = parsed.owner.trim();
    const repo = parsed.name.trim().replace(/\.git$/u, "");
    const port = parsed.port ? Number(parsed.port) : null;
    if (
      !host ||
      !owner ||
      !repo ||
      (port !== null && !Number.isInteger(port))
    ) {
      return null;
    }
    return {
      protocol: parsed.protocol,
      host,
      port,
      owner,
      repo,
      slug: `${owner}/${repo}`,
    };
  } catch {
    return null;
  }
}

/**
 * Return an owner/repo slug only for a trusted GitHub host.
 *
 * `git remote get-url` expands Git `url.*.insteadOf` aliases before this
 * function sees the value. OpenSSH `Host` aliases are not expanded by Git, so
 * callers must explicitly list a trusted alias or GitHub Enterprise hostname
 * in `githubHosts`.
 */
export function parseGitRemoteSlug(
  remote: string,
  options: { githubHosts?: readonly string[] } = {},
): string | null {
  const parsed = parseGitRemote(remote);
  if (!parsed) return null;
  const githubHosts = new Set(
    ["github.com", ...(options.githubHosts ?? [])].map((host) =>
      host.toLowerCase(),
    ),
  );
  return githubHosts.has(parsed.host) ? parsed.slug : null;
}

export function parseGitDiffNameStatus(output: string): DiffNameStatus {
  const changedFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, firstPath, secondPath] = line.split("\t");
    if (!status || !firstPath) continue;
    const kind = status[0];
    if (kind === "D") {
      deletedFiles.add(firstPath);
      continue;
    }
    if (kind === "R") {
      deletedFiles.add(firstPath);
      if (secondPath) changedFiles.add(secondPath);
      continue;
    }
    if (kind === "C") {
      changedFiles.add(secondPath ?? firstPath);
      continue;
    }
    changedFiles.add(firstPath);
  }

  return {
    changedFiles: [...changedFiles].sort(),
    deletedFiles: [...deletedFiles].sort(),
  };
}

export function parseJjDiffSummary(output: string): DiffNameStatus {
  const changedFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line[0];
    const file = line.slice(2).trim();
    if (!file) continue;
    if (status === "D") {
      deletedFiles.add(file);
    } else {
      changedFiles.add(file);
    }
  }

  return {
    changedFiles: [...changedFiles].sort(),
    deletedFiles: [...deletedFiles].sort(),
  };
}

function toNameStatusEntries(summary: DiffNameStatus): NameStatus[] {
  return [
    ...summary.changedFiles.map((path) => ({
      path,
      status: "modified" as const,
    })),
    ...summary.deletedFiles.map((path) => ({
      path,
      status: "deleted" as const,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

async function readGitDiffNameStatus(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
  mergeBase?: boolean;
}): Promise<DiffNameStatus> {
  const refRange =
    input.mergeBase === false
      ? [input.baseRef, input.headRef]
      : [`${input.baseRef}...${input.headRef}`];
  return parseGitDiffNameStatus(
    await commandOutput(
      "git",
      [
        "-C",
        input.rootPath,
        "diff",
        "--name-status",
        "--diff-filter=ACDMRTUXB",
        ...refRange,
        "--",
      ],
      { cwd: input.rootPath, maxBuffer: 25 * 1024 * 1024 },
    ),
  );
}

async function readJjDiffNameStatus(input: {
  rootPath: string;
  baseRef: string;
  headRef: string;
}): Promise<DiffNameStatus> {
  return parseJjDiffSummary(
    await commandOutput(
      "jj",
      [
        "-R",
        input.rootPath,
        "diff",
        "--summary",
        "--from",
        input.baseRef,
        "--to",
        input.headRef,
        "--ignore-working-copy",
      ],
      { cwd: input.rootPath, maxBuffer: 25 * 1024 * 1024 },
    ),
  );
}

export function toJjRootFilePattern(filePath: string): string {
  return `root-file:${JSON.stringify(filePath)}`;
}

async function defaultBranchCandidates(rootPath: string): Promise<string[]> {
  const remoteHead = await commandOutput(
    "git",
    [
      "-C",
      rootPath,
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ],
    { cwd: rootPath },
  ).catch(() => null);
  return uniqueStrings([
    remoteHead,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ]);
}

async function resolveRevisionCommitByPreference(
  rootPath: string,
  revision: string,
  preferred: LocalVcsKind,
): Promise<string | null> {
  const primary =
    preferred === "jj" ? resolveJjRevisionCommit : resolveGitRevisionCommit;
  const secondary =
    preferred === "jj" ? resolveGitRevisionCommit : resolveJjRevisionCommit;
  return (
    (await primary(rootPath, revision).catch(() => null)) ??
    (canUseGitFallbackSync(rootPath, preferred)
      ? await secondary(rootPath, revision).catch(() => null)
      : null)
  );
}

function resolveRevisionCommitByPreferenceSync(
  rootPath: string,
  revision: string,
  preferred: LocalVcsKind,
): string | null {
  const primary =
    preferred === "jj"
      ? resolveJjRevisionCommitSync
      : resolveGitRevisionCommitSync;
  const secondary =
    preferred === "jj"
      ? resolveGitRevisionCommitSync
      : resolveJjRevisionCommitSync;
  return (
    primary(rootPath, revision) ??
    (canUseGitFallbackSync(rootPath, preferred)
      ? secondary(rootPath, revision)
      : null)
  );
}

async function mergeBaseByPreference(
  rootPath: string,
  baseRef: string,
  headRef: string,
  preferred: LocalVcsKind,
): Promise<string | null> {
  const primary = preferred === "jj" ? resolveJjMergeBase : resolveGitMergeBase;
  const secondary =
    preferred === "jj" ? resolveGitMergeBase : resolveJjMergeBase;
  return (
    (await primary(rootPath, baseRef, headRef).catch(() => null)) ??
    (canUseGitFallbackSync(rootPath, preferred)
      ? await secondary(rootPath, baseRef, headRef).catch(() => null)
      : null)
  );
}

async function resolveGitRevisionCommit(
  rootPath: string,
  revision: string,
): Promise<string> {
  return commandOutput("git", [
    "-C",
    rootPath,
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
}

function resolveGitRevisionCommitSync(
  rootPath: string,
  revision: string,
): string | null {
  return commandOutputSync("git", [
    "-C",
    rootPath,
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
}

async function resolveJjRevisionCommit(
  rootPath: string,
  revision: string,
): Promise<string> {
  const output = await commandOutput(
    "jj",
    [
      "-R",
      rootPath,
      "log",
      "--no-graph",
      "-r",
      revision,
      "-T",
      'commit_id ++ "\\n"',
      "--ignore-working-copy",
    ],
    { cwd: rootPath },
  );
  return oneResolvedCommit(output, revision);
}

function resolveJjRevisionCommitSync(
  rootPath: string,
  revision: string,
): string | null {
  const output = commandOutputSync(
    "jj",
    [
      "-R",
      rootPath,
      "log",
      "--no-graph",
      "-r",
      revision,
      "-T",
      'commit_id ++ "\\n"',
      "--ignore-working-copy",
    ],
    { cwd: rootPath },
  );
  return output ? oneResolvedCommit(output, revision) : null;
}

function oneResolvedCommit(output: string, revision: string): string {
  const commits = output.split("\n").filter(Boolean);
  if (commits.length !== 1 || !/^[0-9a-f]{40}$/.test(commits[0]!)) {
    throw new Error(`Revision ${revision} does not resolve to one Git commit.`);
  }
  return commits[0]!;
}

async function resolveGitMergeBase(
  rootPath: string,
  baseRef: string,
  headRef: string,
): Promise<string> {
  return commandOutput("git", ["-C", rootPath, "merge-base", baseRef, headRef]);
}

async function resolveJjMergeBase(
  rootPath: string,
  baseRef: string,
  headRef: string,
): Promise<string | null> {
  const output = await commandOutput(
    "jj",
    [
      "-R",
      rootPath,
      "log",
      "--no-graph",
      "-r",
      `heads(::${baseRef} & ::${headRef})`,
      "-T",
      'commit_id ++ "\n"',
      "--ignore-working-copy",
    ],
    { cwd: rootPath },
  );
  return splitLines(output)[0] ?? null;
}

function readGitFileAtRevisionSync(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
}): { commit: string; source: string } | null {
  const commit = resolveGitRevisionCommitSync(input.rootPath, input.ref);
  if (!commit) return null;
  const source = commandOutputSync(
    "git",
    ["-C", input.rootPath, "show", `${commit}:${input.relativePath}`],
    { maxBuffer: 10 * 1024 * 1024, trim: false },
  );
  return source === null ? null : { commit, source };
}

async function readGitFileAtRevision(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
}): Promise<{ commit: string; source: string } | null> {
  const commit = await resolveGitRevisionCommit(input.rootPath, input.ref);
  if (!commit) return null;
  const source = await commandOutput(
    "git",
    ["-C", input.rootPath, "show", `${commit}:${input.relativePath}`],
    {
      maxBuffer: 10 * 1024 * 1024,
      trim: false,
    },
  );
  return source === null ? null : { commit, source };
}

function readJjFileAtRevisionSync(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
}): { commit: string; source: string } | null {
  const commit = resolveJjRevisionCommitSync(input.rootPath, input.ref);
  if (!commit) return null;
  const source = commandOutputSync(
    "jj",
    [
      "-R",
      input.rootPath,
      "file",
      "show",
      "-r",
      input.ref,
      "--ignore-working-copy",
      "--",
      toJjRootFilePattern(input.relativePath),
    ],
    { cwd: input.rootPath, maxBuffer: 10 * 1024 * 1024, trim: false },
  );
  return source === null ? null : { commit, source };
}

async function readJjFileAtRevision(input: {
  rootPath: string;
  ref: string;
  relativePath: string;
}): Promise<{ commit: string; source: string } | null> {
  const commit = await resolveJjRevisionCommit(input.rootPath, input.ref);
  if (!commit) return null;
  const source = await commandOutput(
    "jj",
    [
      "-R",
      input.rootPath,
      "file",
      "show",
      "-r",
      input.ref,
      "--ignore-working-copy",
      "--",
      toJjRootFilePattern(input.relativePath),
    ],
    {
      cwd: input.rootPath,
      maxBuffer: 10 * 1024 * 1024,
      trim: false,
    },
  );
  return source === null ? null : { commit, source };
}

async function readGitDiff(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  contextLines?: number;
  nameOnly?: boolean;
  paths?: string[];
  mergeBase?: boolean;
}): Promise<string> {
  const paths = normalizeDiffPaths(input.paths);
  const diffRefs = input.headRef
    ? input.mergeBase === false
      ? [input.baseRef, input.headRef]
      : [`${input.baseRef}...${input.headRef}`]
    : [input.baseRef];
  const args = [
    "-C",
    input.rootPath,
    "diff",
    "--no-ext-diff",
    "--no-color",
    "-M",
    ...(input.contextLines !== undefined
      ? [`--unified=${input.contextLines}`]
      : []),
    ...(input.nameOnly ? ["--name-only"] : []),
    ...diffRefs,
    "--",
    ...paths,
  ];
  const { stdout } = await execFileAsync("git", args, {
    cwd: input.rootPath,
    maxBuffer: 25 * 1024 * 1024,
  });
  return stdout;
}

async function readGitDiffFileSummaries(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  paths?: string[];
  mergeBase?: boolean;
}): Promise<LocalVcsDiffFileSummary[]> {
  const paths = normalizeDiffPaths(input.paths);
  const diffRefs = input.headRef
    ? input.mergeBase === false
      ? [input.baseRef, input.headRef]
      : [`${input.baseRef}...${input.headRef}`]
    : [input.baseRef];
  const commonArgs = [
    "-C",
    input.rootPath,
    "diff",
    "--no-ext-diff",
    "--no-color",
    "-M",
    "-z",
    ...diffRefs,
    "--",
    ...paths,
  ];
  const [{ stdout: nameStatus }, { stdout: numStat }] = await Promise.all([
    execFileAsync(
      "git",
      [...commonArgs.slice(0, 7), "--name-status", ...commonArgs.slice(7)],
      {
        cwd: input.rootPath,
        maxBuffer: 25 * 1024 * 1024,
      },
    ),
    execFileAsync(
      "git",
      [...commonArgs.slice(0, 7), "--numstat", ...commonArgs.slice(7)],
      {
        cwd: input.rootPath,
        maxBuffer: 25 * 1024 * 1024,
      },
    ),
  ]);
  const counts = parseGitNumStat(numStat);
  return parseGitNameStatusSummaries(nameStatus).map((file) => ({
    ...file,
    ...(counts.get(file.path) ?? { additions: 0, deletions: 0 }),
  }));
}

async function readJjDiff(input: {
  rootPath: string;
  baseRef: string;
  headRef?: string;
  contextLines?: number;
  nameOnly?: boolean;
  paths?: string[];
}): Promise<string> {
  const paths = normalizeDiffPaths(input.paths);
  const args = [
    "-R",
    input.rootPath,
    "--color",
    "never",
    "--no-pager",
    "diff",
    ...(input.nameOnly ? ["--name-only"] : ["--git"]),
    ...(input.contextLines !== undefined
      ? [`--context=${input.contextLines}`]
      : []),
    "--from",
    input.baseRef,
    ...(input.headRef ? ["--to", input.headRef] : []),
    "--ignore-working-copy",
    ...paths,
  ];
  const { stdout } = await execFileAsync("jj", args, {
    cwd: input.rootPath,
    maxBuffer: 25 * 1024 * 1024,
  });
  return stdout;
}

function parseGitNameStatusSummaries(
  output: string,
): Array<Omit<LocalVcsDiffFileSummary, "additions" | "deletions">> {
  const fields = output.split("\0");
  const files: Array<Omit<LocalVcsDiffFileSummary, "additions" | "deletions">> =
    [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++];
    if (!rawStatus) continue;
    const kind = rawStatus[0];
    if (kind === "R") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath && path) {
        files.push({ path, previousPath, status: "renamed" });
      }
      continue;
    }
    const path = fields[index++];
    if (!path) continue;
    files.push({
      path,
      status: kind === "A" ? "added" : kind === "D" ? "deleted" : "modified",
    });
  }
  return files;
}

function parseGitNumStat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const fields = output.split("\0");
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < fields.length; ) {
    const record = fields[index++];
    if (!record) continue;
    const additionsEnd = record.indexOf("\t");
    const deletionsEnd = record.indexOf("\t", additionsEnd + 1);
    if (additionsEnd < 0 || deletionsEnd < 0) continue;
    const rawAdditions = record.slice(0, additionsEnd);
    const rawDeletions = record.slice(additionsEnd + 1, deletionsEnd);
    let path = record.slice(deletionsEnd + 1);
    if (!path) {
      index += 1;
      path = fields[index++] ?? "";
    }
    if (!path) continue;
    counts.set(path, {
      additions: parseGitNumStatCount(rawAdditions),
      deletions: parseGitNumStatCount(rawDeletions),
    });
  }
  return counts;
}

function parseGitNumStatCount(value: string): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function parseGitPatchFileSummaries(output: string): LocalVcsDiffFileSummary[] {
  return splitGitDiffSections(output).flatMap((section) => {
    const file = parseGitDiffSectionSummary(section);
    return file ? [file] : [];
  });
}

function filterDiffFileSummaries(
  summaries: LocalVcsDiffFileSummary[],
  paths: string[],
): LocalVcsDiffFileSummary[] {
  if (paths.length === 0) return summaries;
  const requested = new Set(paths);
  return summaries.filter(
    (file) =>
      requested.has(file.path) ||
      (file.previousPath !== undefined && requested.has(file.previousPath)),
  );
}

function splitGitDiffSections(diff: string): string[] {
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current.join("\n"));
      current = [line];
    } else {
      current?.push(line);
    }
  }
  if (current) sections.push(current.join("\n"));
  return sections.filter((section) => section.trim().length > 0);
}

function parseGitDiffSectionSummary(
  section: string,
): LocalVcsDiffFileSummary | null {
  const lines = section.split(/\r?\n/);
  const headerPaths = parseDiffGitHeaderPaths(lines[0] ?? "");
  let oldPath: string | null = headerPaths?.oldPath ?? null;
  let newPath: string | null = headerPaths?.newPath ?? null;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    const parsedOldPath = parseGitFileLine(line, "--- ");
    const parsedNewPath = parseGitFileLine(line, "+++ ");
    if (parsedOldPath !== undefined) oldPath = parsedOldPath;
    if (parsedNewPath !== undefined) newPath = parsedNewPath;
    if (line.startsWith("rename from ")) {
      renameFrom = unquoteGitPath(line.slice("rename from ".length).trim());
    }
    if (line.startsWith("rename to ")) {
      renameTo = unquoteGitPath(line.slice("rename to ".length).trim());
    }
    if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
  }

  const status = section.includes("\nnew file mode ")
    ? "added"
    : section.includes("\ndeleted file mode ")
      ? "deleted"
      : section.includes("\nrename from ") && section.includes("\nrename to ")
        ? "renamed"
        : "modified";
  const filePath =
    status === "deleted" ? oldPath : renameTo ? renameTo : (newPath ?? oldPath);
  if (!filePath) return null;
  return {
    path: filePath,
    previousPath:
      status === "renamed" ? (renameFrom ?? oldPath ?? undefined) : undefined,
    status,
    additions,
    deletions,
  };
}

function parseDiffGitHeaderPaths(
  line: string,
): { oldPath: string; newPath: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const tokens = line.slice("diff --git ".length).match(/"([^"\\]|\\.)*"|\S+/g);
  if (!tokens || tokens.length < 2) return null;
  return {
    oldPath: stripDiffPathPrefix(unquoteGitPath(tokens[0])),
    newPath: stripDiffPathPrefix(unquoteGitPath(tokens[1])),
  };
}

function parseGitFileLine(
  line: string,
  prefix: "--- " | "+++ ",
): string | null | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const raw = unquoteGitPath(line.slice(prefix.length).trim());
  if (raw === "/dev/null") return null;
  return stripDiffPathPrefix(raw);
}

function stripDiffPathPrefix(value: string): string {
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith(`"`)) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, value.endsWith(`"`) ? -1 : undefined);
  }
}

function normalizeDiffPaths(paths: string[] | undefined): string[] {
  return [
    ...new Set(
      (paths ?? [])
        .map((path) => path.trim())
        .filter((path) => path.length > 0 && !path.startsWith("-")),
    ),
  ].sort();
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function canUseGitFallbackSync(
  rootPath: string,
  preferred: LocalVcsKind,
): boolean {
  if (preferred !== "jj") return true;
  const gitRoot = commandOutputSync(
    "git",
    ["-C", rootPath, "rev-parse", "--show-toplevel"],
    { cwd: rootPath },
  );
  return gitRoot !== null && canonicalPath(gitRoot) === canonicalPath(rootPath);
}

function isInsideDirectory(filePath: string, directoryPath: string): boolean {
  const relative = path.relative(
    canonicalPath(directoryPath),
    canonicalPath(filePath),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function commandOutput(
  command: string,
  args: string[],
  options: CommandOutputOptions = {},
): Promise<string> {
  return runCommandOutput(command, args, options);
}

function commandOutputSync(
  command: string,
  args: string[],
  options: CommandOutputOptions = {},
): string | null {
  return runCommandOutputSync(command, args, options);
}

function runCommandOutput(
  command: string,
  args: string[],
  options: CommandOutputOptions,
): Promise<string> {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: commandEnvironment(command, args),
    maxBuffer: options.maxBuffer,
  }).then(({ stdout }) =>
    options.trim === false ? stdout : (stdout as string).trim(),
  );
}

function runCommandOutputSync(
  command: string,
  args: string[],
  options: CommandOutputOptions,
): string | null {
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: commandEnvironment(command, args),
      maxBuffer: options.maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return options.trim === false ? output : output.trim();
  } catch {
    return null;
  }
}

function commandEnvironment(
  command: string,
  args: string[],
): NodeJS.ProcessEnv | undefined {
  if (command !== "git" || (args[0] !== "-C" && args[0] !== "--git-dir")) {
    return undefined;
  }
  const env = { ...process.env };
  for (const key of LOCAL_GIT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export * from "./notes";
