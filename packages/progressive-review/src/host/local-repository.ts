import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  detectLocalVcs,
  gitCommonDir,
  resolveRevision,
} from "@dev.fast/local-vcs";
import {
  HOST_RESOURCE_LIMITS,
  type HostBinding,
  type HostChangeSelector,
  HostChangeSelectorSchema,
  HostIdSchema,
  HostOidSchema,
  HostRelativePathSchema,
  type HostSourceRange,
  type HostSourceRead,
} from "@dev.fast/review-protocol";

import { resolvePullRequestReviewSubject } from "../runtime";
import { type DiffHunk, parseUnifiedPatch } from "../unified-diff";
import type { HostChangedLines } from "./document-evidence";
import {
  EvidenceProviderError,
  LocalEvidenceProvider,
} from "./evidence-provider";

export interface LocalRepository {
  localPath: string;
  vcs: "git" | "jj";
  displayName: string;
}

export interface LocalSourceEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "submodule";
  objectId: string;
  byteLength?: number;
}

export interface LocalSourceCommit {
  oid: string;
  parents: string[];
  subject: string;
  author: string;
  at: string;
}

export interface LocalSourceDiffFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
}

/** Registration is called only by the trusted desktop setup boundary. Public
 * authoring requests address the resulting repository ID, never this path. */
export async function resolveRepository(
  localPath: string,
): Promise<LocalRepository> {
  if (!path.isAbsolute(localPath) || /[\u0000-\u001f\u007f]/.test(localPath))
    invalid("Repository registration requires an absolute local directory.");
  return repositoryOperation(async () => {
    const canonical = await realpath(localPath);
    if (!(await stat(canonical)).isDirectory())
      invalid("Repository registration requires a directory.");
    // jj's cwd discovery walks up correctly, including from a subdirectory of
    // a non-colocated workspace nested inside an unrelated Git repository.
    const jjRoot = await run(
      "jj",
      ["root", "--ignore-working-copy"],
      canonical,
    ).catch(() => null);
    const root = jjRoot?.trim() || canonical;
    const vcs = await detectLocalVcs(root);
    if (!vcs) unavailable("No supported Git or jj repository is available.");
    const resolvedPath = await realpath(vcs.rootPath);
    return {
      localPath: resolvedPath,
      vcs: vcs.kind,
      displayName: path.basename(resolvedPath),
    };
  });
}

export async function resolveBinding(
  repositoryId: string,
  localPath: string,
  selector: HostChangeSelector,
): Promise<HostBinding> {
  if (
    !HostIdSchema.safeParse(repositoryId).success ||
    !HostChangeSelectorSchema.safeParse(selector).success
  )
    invalid("The repository identity or change selector is invalid.");
  return repositoryOperation(async () => {
    const repository = await resolveRepository(localPath);
    const revision = async (ref: string) => {
      if (ref.startsWith("-"))
        invalid("Source revisions may not be command options.");
      const resolved = await resolveRevision(repository.localPath, ref);
      if (!resolved || !HostOidSchema.safeParse(resolved.commit).success)
        notFound("The requested source revision is unavailable or not unique.");
      return resolved.commit;
    };
    let baseCommit: string;
    let headCommit: string;
    if (selector.kind === "snapshot") {
      baseCommit = headCommit = await revision(selector.ref);
    } else if (selector.kind === "range") {
      [baseCommit, headCommit] = await Promise.all([
        revision(selector.baseRef),
        revision(selector.headRef),
      ]);
    } else {
      let baseRef: string;
      let headRef: string;
      if (selector.kind === "pull_request") {
        const url = new URL(selector.url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "github.com" ||
          url.port ||
          !/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?$/.test(url.pathname) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          invalid(
            "Pull request selectors require a GitHub HTTPS pull request URL.",
          );
        const subject = await resolvePullRequestReviewSubject({
          cwd: repository.localPath,
          value: selector.url,
        });
        baseRef = subject.baseRef;
        headRef = subject.headRef;
      } else {
        if (selector.kind === "jj_change" && repository.vcs !== "jj")
          invalid("A jj change selector requires a jj repository.");
        baseRef = selector.baseRef;
        headRef =
          selector.kind === "branch" ? selector.name : selector.changeId;
      }
      const [base, head] = await Promise.all([
        revision(baseRef),
        revision(headRef),
      ]);
      headCommit = head;
      const merged = (
        await readGit(repository.localPath, ["merge-base", base, head])
      ).trim();
      if (!HostOidSchema.safeParse(merged).success)
        notFound("The selected revisions have no available common ancestor.");
      baseCommit = merged;
    }
    return {
      id: randomUUID(),
      repositoryId,
      selector: structuredClone(selector),
      baseCommit,
      headCommit,
      createdAt: new Date().toISOString(),
    };
  });
}

/** Immutable source queries. The service resolves review/binding ownership and
 * injects an ID-to-local-path lookup; no client-provided root reaches Git. */
export class LocalRepositorySource {
  private readonly evidence: LocalEvidenceProvider;

  constructor(
    private readonly repositoryPath: (id: string) => string | Promise<string>,
  ) {
    this.evidence = new LocalEvidenceProvider(repositoryPath);
  }

  async quote(binding: HostBinding, range: HostSourceRange, commit?: string) {
    return this.evidence.resolve(
      await this.bindingForSide(binding, range.side, commit),
      range,
    );
  }

  async read(
    binding: HostBinding,
    input: {
      side: "base" | "head";
      file: string;
      range?: { fromLine: number; toLine: number };
      comparisonCommit?: string;
    },
  ): Promise<HostSourceRead> {
    if (input.range) {
      const quote = await this.quote(
        binding,
        {
          side: input.side,
          file: input.file,
          ...input.range,
        },
        input.comparisonCommit,
      );
      const { fromLine, toLine, ...identity } = quote.span;
      return {
        ...identity,
        range: { fromLine, toLine },
        text: quote.text,
        sha256: quote.sha256,
      };
    }
    return {
      ...(await this.file(
        binding,
        input.side,
        input.file,
        input.comparisonCommit,
      )),
      range: null,
    };
  }

  async file(
    binding: HostBinding,
    side: "base" | "head",
    file: string,
    commit?: string,
  ) {
    return this.evidence.readFile(
      await this.bindingForSide(binding, side, commit),
      side,
      file,
    );
  }

  private async comparison(
    binding: HostBinding,
    commit?: string,
  ): Promise<{ baseCommit: string | null; headCommit: string }> {
    validatePins(binding);
    if (!commit) return binding;
    if (!HostOidSchema.safeParse(commit).success)
      invalid("Commit comparisons require a full immutable commit ID.");
    const selected = (await this.commits(binding)).find(
      (entry) => entry.oid === commit,
    );
    if (!selected) notFound("The commit is not part of this pinned review.");
    // Like the existing commit view, merges compare against their first parent.
    return {
      baseCommit: selected.parents[0] ?? null,
      headCommit: selected.oid,
    };
  }

  private async bindingForSide(
    binding: HostBinding,
    side: "base" | "head",
    commit?: string,
  ): Promise<HostBinding> {
    if (!commit) return binding;
    const comparison = await this.comparison(binding, commit);
    if (side === "base" && comparison.baseCommit === null)
      notFound("A root commit has no base-side source file.");
    // The empty side of a root commit is represented by an absent editor, not
    // fabricated bytes or a synthetic source commit.
    const selected =
      side === "base" ? comparison.baseCommit! : comparison.headCommit;
    return { ...binding, baseCommit: selected, headCommit: selected };
  }

  async tree(
    binding: HostBinding,
    side: "base" | "head",
    directory = "",
    commitScope?: string,
  ): Promise<LocalSourceEntry[]> {
    if (directory !== "") validatePath(directory);
    binding = await this.bindingForSide(binding, side, commitScope);
    const commit = pinnedCommit(binding, side);
    const root = await this.root(binding);
    if (directory) {
      const entry = (
        await readGit(root, ["ls-tree", "-z", commit, "--", directory])
      )
        .split("\0")
        .find((value) => value.slice(value.indexOf("\t") + 1) === directory);
      if (!entry)
        notFound("The source directory is absent from the pinned commit.");
      if (!entry.startsWith("040000 "))
        invalid("The selected source path is not a directory.");
    }
    const output = await readGit(root, [
      "ls-tree",
      "-z",
      "-l",
      directory ? `${commit}:${directory}` : commit,
    ]);
    return output
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        if (tab < 0) unavailable("The source tree could not be read.");
        const [mode, , objectId, rawSize] = entry
          .slice(0, tab)
          .trim()
          .split(/\s+/);
        if (!objectId || !HostOidSchema.safeParse(objectId).success)
          unavailable("The source tree could not be read.");
        const name = entry.slice(tab + 1);
        const result: LocalSourceEntry = {
          path: directory ? `${directory}/${name}` : name,
          objectId,
          kind:
            mode === "040000"
              ? "directory"
              : mode === "120000"
                ? "symlink"
                : mode === "160000"
                  ? "submodule"
                  : "file",
        };
        if (rawSize !== "-") {
          const size = Number(rawSize);
          if (!Number.isSafeInteger(size) || size < 0)
            unavailable("The source tree could not be read.");
          result.byteLength = size;
        }
        return result;
      })
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
  }

  async commits(binding: HostBinding): Promise<LocalSourceCommit[]> {
    validatePins(binding);
    const root = await this.root(binding);
    const output = await readGit(root, [
      "-c",
      "log.showSignature=false",
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "--topo-order",
      "--max-count=501",
      "--format=%H%x00%P%x00%an%x00%aI%x00%s",
      "-z",
      `${binding.baseCommit}..${binding.headCommit}`,
    ]);
    const fields = output.split("\0");
    if (fields.at(-1) === "") fields.pop();
    const commits: LocalSourceCommit[] = [];
    for (let index = 0; index < fields.length; index += 5) {
      const [oid, rawParents, author, at, subject] = fields.slice(
        index,
        index + 5,
      );
      const parents = rawParents?.split(" ").filter(Boolean) ?? [];
      if (
        !oid ||
        !HostOidSchema.safeParse(oid).success ||
        parents.some((parent) => !HostOidSchema.safeParse(parent).success) ||
        author === undefined ||
        at === undefined ||
        subject === undefined
      )
        unavailable("The source commit history could not be read.");
      const timestamp = Date.parse(at);
      if (!Number.isFinite(timestamp))
        unavailable("The source commit timestamp could not be read.");
      commits.push({
        oid,
        parents,
        author,
        at: new Date(timestamp).toISOString(),
        subject,
      });
    }
    if (commits.length > 500)
      throw new EvidenceProviderError(
        "RESOURCE_LIMIT",
        "The selected source history exceeds 500 commits. Select a smaller range.",
      );
    return commits;
  }

  async diffFiles(
    binding: HostBinding,
    commit?: string,
  ): Promise<LocalSourceDiffFile[]> {
    const comparison = await this.comparison(binding, commit);
    const root = await this.root(binding);
    const prefix = [
      ...(comparison.baseCommit === null
        ? ["diff-tree", "--root", "--no-commit-id", "-r"]
        : ["diff"]),
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-M",
    ];
    const refs = [
      ...(comparison.baseCommit === null ? [] : [comparison.baseCommit]),
      comparison.headCommit,
      "--",
    ];
    const [names, stats] = await Promise.all([
      readGit(root, [...prefix, "--name-status", "-z", ...refs]),
      readGit(root, [...prefix, "--numstat", "-z", ...refs]),
    ]);
    const counts = new Map<
      string,
      { additions: number; deletions: number; binary: boolean }
    >();
    const statFields = stats.split("\0");
    for (let i = 0; i < statFields.length; i++) {
      const field = statFields[i];
      if (!field) continue;
      const firstTab = field.indexOf("\t"),
        secondTab = field.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0)
        unavailable("The source diff could not be read.");
      const added = field.slice(0, firstTab),
        deleted = field.slice(firstTab + 1, secondTab);
      let file = field.slice(secondTab + 1);
      if (!file) {
        i += 2;
        file = statFields[i]!;
      }
      counts.set(file, {
        additions: added === "-" ? 0 : Number(added),
        deletions: deleted === "-" ? 0 : Number(deleted),
        binary: added === "-" || deleted === "-",
      });
    }
    const result: LocalSourceDiffFile[] = [];
    const nameFields = names.split("\0");
    for (let i = 0; i < nameFields.length; ) {
      const status = nameFields[i++];
      if (!status) continue;
      const oldPath = nameFields[i++];
      const newPath = status.startsWith("R") ? nameFields[i++] : oldPath;
      if (!newPath) unavailable("The source diff could not be read.");
      const file: LocalSourceDiffFile = {
        path: newPath,
        status: status.startsWith("R")
          ? "renamed"
          : status === "A"
            ? "added"
            : status === "D"
              ? "deleted"
              : "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        ...counts.get(newPath),
      };
      if (status.startsWith("R")) file.previousPath = oldPath;
      result.push(file);
    }
    return result.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  }

  async analysisPatch(binding: HostBinding): Promise<string> {
    validatePins(binding);
    const root = await this.root(binding);
    return readGit(
      root,
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=0",
        "-M",
        binding.baseCommit,
        binding.headCommit,
        "--",
      ],
      HOST_RESOURCE_LIMITS.analysisDiffBytes,
    );
  }

  async diffHunks(
    binding: HostBinding,
    file: string,
    side: "base" | "head" = "head",
  ): Promise<DiffHunk[]> {
    validatePath(file);
    pinnedCommit(binding, side);
    const match = (await this.diffFiles(binding)).find(
      (entry) =>
        (side === "base" ? (entry.previousPath ?? entry.path) : entry.path) ===
        file,
    );
    if (!match) notFound("The file is not part of the pinned change.");
    return this.hunks(binding, match);
  }

  async changedLines(
    binding: HostBinding,
    file: string,
    side: "base" | "head",
  ): Promise<HostChangedLines | null> {
    validatePath(file);
    pinnedCommit(binding, side);
    const match = (await this.diffFiles(binding)).find(
      (entry) =>
        (side === "base" ? (entry.previousPath ?? entry.path) : entry.path) ===
        file,
    );
    if (!match) return null;
    const added = new Set<number>(),
      deleted = new Set<number>();
    for (const hunk of await this.hunks(binding, match))
      for (const line of hunk.lines) {
        if (line.kind === "add" && line.newLine !== null)
          added.add(line.newLine);
        if (line.kind === "remove" && line.oldLine !== null)
          deleted.add(line.oldLine);
      }
    return { added, deleted };
  }

  private async hunks(
    binding: HostBinding,
    file: LocalSourceDiffFile,
  ): Promise<DiffHunk[]> {
    if (file.binary) return [];
    const root = await this.root(binding);
    const paths = [
      ...new Set(
        [file.path, file.previousPath].filter(
          (value): value is string => value !== undefined,
        ),
      ),
    ];
    paths.forEach(validatePath);
    const patch = await readGit(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-M",
      "--unified=3",
      binding.baseCommit,
      binding.headCommit,
      "--",
      ...paths,
    ]);
    if (
      patch.split("\n").filter((line) => line.startsWith("diff --git "))
        .length > 1
    )
      unavailable("The source diff did not identify one exact file.");
    return parseUnifiedPatch(file.path, patch);
  }

  private root(binding: HostBinding): Promise<string> {
    return repositoryOperation(async () =>
      this.repositoryPath(binding.repositoryId),
    );
  }
}

function validatePins(binding: HostBinding): void {
  if (
    !HostOidSchema.safeParse(binding.baseCommit).success ||
    !HostOidSchema.safeParse(binding.headCommit).success
  )
    invalid("Source queries require exact commit IDs.");
}

function pinnedCommit(binding: HostBinding, side: "base" | "head"): string {
  validatePins(binding);
  if (side !== "base" && side !== "head")
    invalid("Source queries require a base or head side.");
  return side === "base" ? binding.baseCommit : binding.headCommit;
}

function validatePath(file: string): void {
  if (!HostRelativePathSchema.safeParse(file).success)
    invalid("Source paths must be normalized repository-relative paths.");
}

async function readGit(
  root: string,
  args: string[],
  maxBytes = 4 * 1024 * 1024,
): Promise<string> {
  return repositoryOperation(async () => {
    const gitDir = await gitCommonDir(root);
    if (!gitDir) unavailable("The source repository is unavailable.");
    return run(
      "git",
      ["--no-replace-objects", "--git-dir", gitDir, ...args],
      undefined,
      maxBytes,
    );
  });
}

function run(
  command: "git" | "jj",
  args: string[],
  cwd?: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<string> {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
  };
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: maxBytes,
        timeout: 10_000,
      },
      (error, stdout) =>
        error
          ? reject(
              new EvidenceProviderError(
                error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  ? "RESOURCE_LIMIT"
                  : "DEPENDENCY_UNAVAILABLE",
                error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  ? "The source output exceeds its byte limit."
                  : "The source repository operation is unavailable.",
              ),
            )
          : resolve(stdout),
    ),
  );
}

async function repositoryOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EvidenceProviderError) throw error;
    return unavailable("The source repository is unavailable.");
  }
}

function invalid(message: string): never {
  throw new EvidenceProviderError("INVALID_REQUEST", message);
}
function notFound(message: string): never {
  throw new EvidenceProviderError("NOT_FOUND", message);
}
function unavailable(message: string): never {
  throw new EvidenceProviderError("DEPENDENCY_UNAVAILABLE", message);
}
