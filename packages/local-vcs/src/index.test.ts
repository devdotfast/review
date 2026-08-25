import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  changeIdentityForRevision,
  defaultBranch,
  detectLocalVcs,
  detectLocalVcsSync,
  devfastPrepareCommands,
  diff,
  diffFileSummaries,
  diffNameStatus,
  diffNameStatusTrees,
  diffTrees,
  gitCommonDir,
  gitCommonDirSync,
  listCommitRange,
  listTrackedFilesSync,
  parseGitRemote,
  parseGitRemoteSlug,
  parseJjDiffSummary,
  readFileAtRevision,
  resolveRepoContext,
  resolveRepoContextSync,
} from ".";

describe("local vcs", () => {
  it("lists a Git commit range newest first with summary counts", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-git-log-"));
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(rootPath, "app.ts"), "one\n");
    execGit(rootPath, ["add", "app.ts"]);
    execGit(rootPath, ["commit", "-m", "base"]);
    const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(rootPath, "app.ts"), "one\ntwo\n");
    execGit(rootPath, ["commit", "-am", "first change"]);
    writeFileSync(path.join(rootPath, "other.ts"), "new\n");
    execGit(rootPath, ["add", "other.ts"]);
    execGit(rootPath, ["commit", "-m", "second change"]);
    const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

    const commits = await listCommitRange({ rootPath, baseRef, headRef });

    expect(commits.map((commit) => commit.subject)).toEqual([
      "second change",
      "first change",
    ]);
    expect(commits.map((commit) => commit.fileCount)).toEqual([1, 1]);
    expect(commits.map((commit) => commit.additions)).toEqual([1, 1]);
    expect(commits[0]).toMatchObject({
      author: "Test User",
      parentCommit: commits[1]?.commit,
    });
  });

  it("lists a Jujutsu commit range from exact commit ids", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-jj-log-"));
    execFileSync("jj", ["git", "init", rootPath]);
    execFileSync("jj", ["config", "set", "--repo", "user.name", "JJ User"], {
      cwd: rootPath,
    });
    execFileSync(
      "jj",
      ["config", "set", "--repo", "user.email", "jj@example.com"],
      { cwd: rootPath },
    );
    writeFileSync(path.join(rootPath, "app.ts"), "base\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: rootPath });
    const baseRef = execFileSync(
      "jj",
      ["log", "-r", "@-", "--no-graph", "-T", "commit_id"],
      { cwd: rootPath, encoding: "utf8" },
    ).trim();
    writeFileSync(path.join(rootPath, "app.ts"), "base\nchange\n");
    execFileSync("jj", ["commit", "-m", "jj change"], { cwd: rootPath });
    const headRef = execFileSync(
      "jj",
      ["log", "-r", "@-", "--no-graph", "-T", "commit_id"],
      { cwd: rootPath, encoding: "utf8" },
    ).trim();

    await expect(
      listCommitRange({ rootPath, baseRef, headRef }),
    ).resolves.toMatchObject([
      {
        commit: headRef,
        parentCommit: baseRef,
        subject: "jj change",
        fileCount: 1,
        additions: 1,
      },
    ]);
  });

  it("detects a git repository and lists tracked files", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-git-"));
    execFileSync("git", ["init"], { cwd: rootPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: rootPath,
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: rootPath,
    });
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(path.join(rootPath, "src/app.ts"), "export const app = 1;\n");
    execFileSync("git", ["add", "src/app.ts"], { cwd: rootPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: rootPath });
    const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
    const branch = execGitOutput(rootPath, ["symbolic-ref", "--short", "HEAD"]);

    expect(detectLocalVcsSync(rootPath)).toMatchObject({ kind: "git" });
    expect(listTrackedFilesSync({ rootPath })).toEqual(["src/app.ts"]);
    await expect(changeIdentityForRevision(rootPath, branch)).resolves.toEqual({
      kind: "git-branch",
      name: branch,
    });
    await expect(changeIdentityForRevision(rootPath, commit)).resolves.toEqual({
      kind: "git-commit",
      name: commit,
    });
  });

  it("limits git diffs to requested paths", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-git-diff-"));
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(path.join(rootPath, "src/app.ts"), "export const app = 1;\n");
    writeFileSync(
      path.join(rootPath, "src/other.ts"),
      "export const other = 1;\n",
    );
    execGit(rootPath, ["add", "src/app.ts", "src/other.ts"]);
    execGit(rootPath, ["commit", "-m", "initial"]);
    const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(rootPath, "src/app.ts"), "export const app = 2;\n");
    writeFileSync(
      path.join(rootPath, "src/other.ts"),
      "export const other = 2;\n",
    );
    execGit(rootPath, ["add", "src/app.ts", "src/other.ts"]);
    execGit(rootPath, ["commit", "-m", "change"]);
    const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

    const patch = await diff({
      rootPath,
      baseRef,
      headRef,
      paths: ["src/app.ts"],
    });

    expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(patch).not.toContain("src/other.ts");
  });

  it("keeps three-dot name-status semantics by default and exposes two-tree name-status for graph plans", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-git-trees-"));
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    execGit(rootPath, ["checkout", "-b", "main"]);
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(
      path.join(rootPath, "src/shared.ts"),
      "export const shared = 1;\n",
    );
    execGit(rootPath, ["add", "src/shared.ts"]);
    execGit(rootPath, ["commit", "-m", "initial"]);

    execGit(rootPath, ["checkout", "-b", "feature"]);
    writeFileSync(
      path.join(rootPath, "src/head-only.ts"),
      "export const headOnly = 1;\n",
    );
    execGit(rootPath, ["add", "src/head-only.ts"]);
    execGit(rootPath, ["commit", "-m", "head only"]);
    const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

    execGit(rootPath, ["checkout", "main"]);
    writeFileSync(
      path.join(rootPath, "src/base-only.ts"),
      "export const baseOnly = 1;\n",
    );
    execGit(rootPath, ["add", "src/base-only.ts"]);
    execGit(rootPath, ["commit", "-m", "base only"]);
    const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

    await expect(
      diffNameStatus({ rootPath, baseRef, headRef }),
    ).resolves.toEqual({
      changedFiles: ["src/head-only.ts"],
      deletedFiles: [],
    });
    await expect(
      diffNameStatusTrees({ rootPath, baseRef, headRef }),
    ).resolves.toEqual({
      changedFiles: ["src/head-only.ts"],
      deletedFiles: ["src/base-only.ts"],
    });
    await expect(
      diffTrees({
        rootPath,
        baseRef,
        headRef,
        paths: ["src/base-only.ts"],
      }),
    ).resolves.toContain("deleted file mode");
  });

  it("reads patch-free Git file summaries with statuses, renames, binary files, and exact counts", async () => {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-git-summary-"),
    );
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(path.join(rootPath, "src/modified.ts"), "one\nkeep\n");
    writeFileSync(path.join(rootPath, "src/deleted.ts"), "gone\n");
    writeFileSync(path.join(rootPath, "src/rename old.ts"), "renamed\n");
    writeFileSync(path.join(rootPath, "src/tab\tname.ts"), "before\n");
    writeFileSync(path.join(rootPath, "src/binary.dat"), Buffer.from([0, 1]));
    execGit(rootPath, ["add", "src"]);
    execGit(rootPath, ["commit", "-m", "initial"]);
    const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(rootPath, "src/modified.ts"), "two\nkeep\nextra\n");
    writeFileSync(path.join(rootPath, "src/added file.ts"), "a\nb\n");
    writeFileSync(path.join(rootPath, "src/tab\tname.ts"), "after\n");
    writeFileSync(path.join(rootPath, "src/binary.dat"), Buffer.from([0, 2]));
    execGit(rootPath, ["rm", "src/deleted.ts"]);
    execGit(rootPath, ["mv", "src/rename old.ts", "src/renamed new.ts"]);
    execGit(rootPath, ["add", "src"]);
    execGit(rootPath, ["commit", "-m", "change"]);
    const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

    const summaries = await diffFileSummaries({
      rootPath,
      baseRef,
      headRef,
    });
    expect(summaries).toHaveLength(6);
    expect(summaries).toEqual(
      expect.arrayContaining([
        {
          path: "src/added file.ts",
          status: "added",
          additions: 2,
          deletions: 0,
        },
        {
          path: "src/binary.dat",
          status: "modified",
          additions: 0,
          deletions: 0,
        },
        {
          path: "src/deleted.ts",
          status: "deleted",
          additions: 0,
          deletions: 1,
        },
        {
          path: "src/modified.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
        {
          path: "src/tab\tname.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
        {
          path: "src/renamed new.ts",
          previousPath: "src/rename old.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
      ]),
    );
    await expect(
      diffFileSummaries({
        rootPath,
        baseRef,
        headRef,
        paths: ["src/renamed new.ts"],
      }),
    ).resolves.toEqual([
      {
        path: "src/renamed new.ts",
        previousPath: "src/rename old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("uses jj local semantics for jj-only revisions", async () => {
    if (!commandExists("jj")) return;

    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-jj-"));
    execJj(rootPath, ["git", "init"]);
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(path.join(rootPath, "src/app.ts"), "export const app = 1;\n");
    const baseRef = execJjOutput(rootPath, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "change_id.short()",
    ]);
    execJj(rootPath, ["new"]);
    writeFileSync(path.join(rootPath, "src/app.ts"), "export const app = 2;\n");
    const headRef = execJjOutput(rootPath, [
      "log",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "change_id.short()",
    ]);

    expect(() =>
      execFileSync("git", ["diff", `${baseRef}...${headRef}`], {
        cwd: rootPath,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).toThrow(/./);
    expect(detectLocalVcsSync(rootPath)).toMatchObject({ kind: "jj" });
    const vcs = await detectLocalVcs(rootPath);
    expect(vcs).toMatchObject({ kind: "jj" });
    await expect(vcs?.currentHead()).resolves.toMatchObject({
      commit: expect.any(String),
    });
    await expect(
      vcs?.diffNameStatus({ base: baseRef, head: headRef }),
    ).resolves.toEqual([{ path: "src/app.ts", status: "modified" }]);
    expect(listTrackedFilesSync({ rootPath })).toEqual(["src/app.ts"]);

    await expect(
      diff({ rootPath, baseRef, headRef, contextLines: 0 }),
    ).resolves.toContain("+export const app = 2;");
    await expect(
      diffNameStatus({ rootPath, baseRef, headRef }),
    ).resolves.toEqual({
      changedFiles: ["src/app.ts"],
      deletedFiles: [],
    });
    await expect(
      diffFileSummaries({ rootPath, baseRef, headRef }),
    ).resolves.toEqual([
      {
        path: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
    ]);
    await expect(
      changeIdentityForRevision(rootPath, headRef),
    ).resolves.toMatchObject({
      kind: "jj-change",
      name: expect.stringMatching(new RegExp(`^${headRef}`)),
    });
  });

  it("binds a Git-only commit by its exact commit id in a colocated jj repo", async () => {
    if (!commandExists("jj")) return;

    const rootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-jj-git-sha-"),
    );
    execJj(rootPath, ["git", "init", "--colocate"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(rootPath, "git-only.txt"), "git only\n");
    execGit(rootPath, ["add", "git-only.txt"]);
    const tree = execGitOutput(rootPath, ["write-tree"]);
    const commit = execFileSync("git", ["-C", rootPath, "commit-tree", tree], {
      input: "git-only commit\n",
      encoding: "utf8",
    }).trim();

    expect(() =>
      execFileSync("jj", ["-R", rootPath, "log", "--no-graph", "-r", commit], {
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).toThrow(/./);
    await expect(changeIdentityForRevision(rootPath, commit)).resolves.toEqual({
      kind: "git-commit",
      name: commit,
    });
  });

  it("reads devfast.prepare commands in configuration order", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "local-vcs-prepare-"));
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "devfast.prepare", "pnpm install"]);
    execGit(rootPath, ["config", "--add", "devfast.prepare", "uv sync"]);

    await expect(devfastPrepareCommands(rootPath)).resolves.toEqual([
      "pnpm install",
      "uv sync",
    ]);
  });

  it("reads devfast.prepare through the shared git dir of a linked worktree", async () => {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-prepare-wt-"),
    );
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(rootPath, "README.md"), "prepare\n");
    execGit(rootPath, ["add", "README.md"]);
    execGit(rootPath, ["commit", "-m", "initial"]);
    execGit(rootPath, ["config", "devfast.prepare", "pnpm install"]);
    const worktreePath = path.join(rootPath, ".linked-worktree");
    execGit(rootPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

    await expect(devfastPrepareCommands(worktreePath)).resolves.toEqual([
      "pnpm install",
    ]);
  });

  it("returns no devfast.prepare commands when none are configured", async () => {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-prepare-none-"),
    );
    execGit(rootPath, ["init"]);

    await expect(devfastPrepareCommands(rootPath)).resolves.toEqual([]);
  });

  it("does not use an enclosing Git repository as the default branch for non-colocated jj workspaces", async () => {
    if (!commandExists("jj")) return;

    const parentRootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-parent-git-"),
    );
    execGit(parentRootPath, ["init"]);
    execGit(parentRootPath, ["config", "user.email", "test@example.com"]);
    execGit(parentRootPath, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(parentRootPath, "README.md"), "parent\n");
    execGit(parentRootPath, ["add", "README.md"]);
    execGit(parentRootPath, ["commit", "-m", "parent"]);

    const rootPath = path.join(parentRootPath, "repos", "project");
    mkdirSync(path.dirname(rootPath), { recursive: true });
    execJj(parentRootPath, ["git", "init", "--no-colocate", rootPath]);
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(path.join(rootPath, "src/app.ts"), "export const app = 1;\n");

    expect(detectLocalVcsSync(rootPath)).toMatchObject({ kind: "jj" });
    await expect(defaultBranch(rootPath)).resolves.toBeNull();
  });

  it("resolves the shared git dir of a nested non-colocated jj workspace to its jj store, not the enclosing repo", async () => {
    if (!commandExists("jj")) return;

    const parentRootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-parent-git-dir-"),
    );
    execGit(parentRootPath, ["init"]);
    execGit(parentRootPath, ["config", "user.email", "test@example.com"]);
    execGit(parentRootPath, ["config", "user.name", "Test User"]);
    writeFileSync(path.join(parentRootPath, "README.md"), "parent\n");
    execGit(parentRootPath, ["add", "README.md"]);
    execGit(parentRootPath, ["commit", "-m", "parent"]);

    const rootPath = path.join(parentRootPath, "repos", "project");
    mkdirSync(path.dirname(rootPath), { recursive: true });
    execJj(parentRootPath, ["git", "init", "--no-colocate", rootPath]);

    const gitDir = await gitCommonDir(rootPath);
    expect(gitDir).not.toBeNull();
    // The jj backing store, not the outer repo's .git.
    expect(gitDir).toContain(`${path.sep}.jj${path.sep}`);
    expect(gitDir).not.toBe(
      realpathSync.native(path.join(parentRootPath, ".git")),
    );

    expect(gitCommonDirSync(rootPath)).toBe(gitDir);

    // From a SUBDIRECTORY of the workspace: jj must walk up from cwd (`-R
    // <subdir>` does not walk up and would silently fall back to git's cwd
    // walk, resolving the OUTER repo's git dir).
    const subdir = path.join(rootPath, "packages", "deep");
    mkdirSync(subdir, { recursive: true });
    expect(await gitCommonDir(subdir)).toBe(gitDir);
    expect(gitCommonDirSync(subdir)).toBe(gitDir);
  });

  it("resolves repo context from a nested non-colocated jj store instead of the enclosing Git repo", async () => {
    if (!commandExists("jj")) return;

    const parentRootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-parent-repo-context-"),
    );
    execGit(parentRootPath, ["init"]);
    execGit(parentRootPath, [
      "remote",
      "add",
      "origin",
      "git@github.com:Outer/monorepo.git",
    ]);

    const rootPath = path.join(parentRootPath, "repos", "project");
    mkdirSync(path.dirname(rootPath), { recursive: true });
    execJj(parentRootPath, ["git", "init", "--no-colocate", rootPath]);
    const innerGitDir = execJjOutput(rootPath, ["git", "root"]);
    execFileSync(
      "git",
      [
        "--git-dir",
        innerGitDir,
        "remote",
        "add",
        "origin",
        "https://github.com/Fix-Fast/dev.git",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    await expect(resolveRepoContext(rootPath)).resolves.toEqual({
      commonDir: innerGitDir,
      originUrl: "https://github.com/Fix-Fast/dev.git",
      githubSlug: "Fix-Fast/dev",
    });

    expect(resolveRepoContextSync(rootPath)).toEqual({
      commonDir: innerGitDir,
      originUrl: "https://github.com/Fix-Fast/dev.git",
      githubSlug: "Fix-Fast/dev",
    });

    execFileSync(
      "git",
      [
        "--git-dir",
        innerGitDir,
        "config",
        "remote.origin.url",
        "fixture:Fix-Fast/dev.git",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    execFileSync(
      "git",
      [
        "--git-dir",
        innerGitDir,
        "config",
        "url.https://github.com/.insteadOf",
        "fixture:",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    await expect(resolveRepoContext(rootPath)).resolves.toEqual({
      commonDir: innerGitDir,
      originUrl: "fixture:Fix-Fast/dev.git",
      githubSlug: "Fix-Fast/dev",
    });
  });

  it("normalizes Git remotes without losing host, port, or owner case", () => {
    expect(parseGitRemote("git@github.com:Fix-Fast/dev.git")).toEqual({
      protocol: "ssh",
      host: "github.com",
      port: null,
      owner: "Fix-Fast",
      repo: "dev",
      slug: "Fix-Fast/dev",
    });
    expect(
      parseGitRemote("ssh://git@GHE.Example.com:2222/Mixed-Case/App.git"),
    ).toEqual({
      protocol: "ssh",
      host: "ghe.example.com",
      port: 2222,
      owner: "Mixed-Case",
      repo: "App",
      slug: "Mixed-Case/App",
    });
    expect(parseGitRemote("https://gitlab.com/Team/service.git")).toMatchObject(
      {
        protocol: "https",
        host: "gitlab.com",
        owner: "Team",
        repo: "service",
      },
    );
    expect(parseGitRemote("not a remote")).toBeNull();
  });

  it("normalizes the remote after Git applies url.insteadOf", async () => {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-remote-alias-"),
    );
    execGit(rootPath, ["init"]);
    execGit(rootPath, [
      "config",
      "url.ssh://git@github.com/.insteadOf",
      "github-work:",
    ]);
    execGit(rootPath, [
      "remote",
      "add",
      "origin",
      "github-work:Fix-Fast/dev.git",
    ]);

    await expect(resolveRepoContext(rootPath)).resolves.toMatchObject({
      originUrl: "github-work:Fix-Fast/dev.git",
      githubSlug: "Fix-Fast/dev",
    });
  });

  it("parses trusted GitHub remote slugs", () => {
    expect(parseGitRemoteSlug("git@github.com:Fix-Fast/dev.git")).toBe(
      "Fix-Fast/dev",
    );
    expect(parseGitRemoteSlug("git@github.com:Fix-Fast/dev")).toBe(
      "Fix-Fast/dev",
    );
    expect(parseGitRemoteSlug("https://github.com/Fix-Fast/dev.git")).toBe(
      "Fix-Fast/dev",
    );
    expect(parseGitRemoteSlug("https://github.com/Fix-Fast/dev")).toBe(
      "Fix-Fast/dev",
    );
    expect(parseGitRemoteSlug("ssh://git@github.com/Fix-Fast/dev.git")).toBe(
      "Fix-Fast/dev",
    );
    expect(
      parseGitRemoteSlug("https://gitlab.com/Fix-Fast/dev.git"),
    ).toBeNull();
    // scp-style remotes on non-github hosts must yield null, not a garbage
    // truthy slug like "git@gitlab.com:Team/app".
    expect(parseGitRemoteSlug("git@gitlab.com:Team/app.git")).toBeNull();
    expect(parseGitRemoteSlug("ssh://git@gitlab.com/Team/app.git")).toBeNull();
    expect(parseGitRemoteSlug("git@bitbucket.org:Team/app")).toBeNull();
    expect(
      parseGitRemoteSlug("git@github-work:Mixed/Case.git", {
        githubHosts: ["github-work"],
      }),
    ).toBe("Mixed/Case");
    expect(
      parseGitRemoteSlug("ssh://git@ghe.example.com:2222/Enterprise/Repo.git", {
        githubHosts: ["ghe.example.com"],
      }),
    ).toBe("Enterprise/Repo");
  });

  it("parses jj diff summaries into changed and deleted file groups", () => {
    expect(
      parseJjDiffSummary("M src/app.ts\nD src/old.ts\nA src/new.ts\n"),
    ).toEqual({
      changedFiles: ["src/app.ts", "src/new.ts"],
      deletedFiles: ["src/old.ts"],
    });
  });

  it("reads file source at a revision asynchronously", async () => {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), "local-vcs-read-file-revision-"),
    );
    execGit(rootPath, ["init"]);
    execGit(rootPath, ["config", "user.email", "test@example.com"]);
    execGit(rootPath, ["config", "user.name", "Test User"]);
    mkdirSync(path.join(rootPath, "src"));
    writeFileSync(
      path.join(rootPath, "src", "app.ts"),
      "export const app = 1;\n",
    );
    execGit(rootPath, ["add", "src/app.ts"]);
    execGit(rootPath, ["commit", "-m", "initial"]);

    await expect(
      readFileAtRevision({ rootPath, ref: "HEAD", relativePath: "src/app.ts" }),
    ).resolves.toMatchObject({ source: "export const app = 1;\n" });
    await expect(
      readFileAtRevision({
        rootPath,
        ref: "HEAD",
        relativePath: "src/missing.ts",
      }),
    ).resolves.toBeNull();
  });
});

function execJj(cwd: string, args: string[]) {
  execFileSync("jj", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function execGit(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function execGitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function execJjOutput(cwd: string, args: string[]): string {
  return execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
