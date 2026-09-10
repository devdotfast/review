import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalRepositorySource,
  resolveBinding,
  resolveRepository,
} from "./local-repository";

const repositoryId = "00000000-0000-4000-8000-000000000001";
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("host-controlled local repositories", () => {
  it("registers the canonical repository root from a symlink or subdirectory", async () => {
    const root = fixture();
    mkdirSync(path.join(root, "nested"));
    const alias = path.join(temp(), "linked");
    symlinkSync(root, alias);
    const expected = {
      localPath: realpathSync(root),
      vcs: "git",
      displayName: path.basename(root),
    };
    await expect(resolveRepository(alias)).resolves.toEqual(expected);
    await expect(resolveRepository(path.join(root, "nested"))).resolves.toEqual(
      expected,
    );
  });

  it.skipIf(!hasJj())(
    "prefers the nested non-colocated jj root, including from its subdirectory",
    async () => {
      const outer = fixture();
      const inner = path.join(outer, "inner");
      execFileSync("jj", ["git", "init", "--no-colocate", inner], {
        cwd: outer,
        stdio: "ignore",
      });
      mkdirSync(path.join(inner, "nested"));
      await expect(
        resolveRepository(path.join(inner, "nested")),
      ).resolves.toMatchObject({ localPath: realpathSync(inner), vcs: "jj" });
      const snapshot = await resolveBinding(repositoryId, inner, {
        kind: "snapshot",
        ref: "@",
      });
      expect(snapshot.baseCommit).toBe(snapshot.headCommit);
      expect(snapshot.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it("rejects non-repositories and sanitizes local lookup failures", async () => {
    const privatePath = path.join(temp(), "private-missing-project");
    await expect(resolveRepository(privatePath)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "The source repository is unavailable.",
    });
    await expect(resolveRepository(temp())).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    await expect(resolveRepository("relative/project")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("resolves exact range endpoints, branch fork points and snapshots independently", async () => {
    const root = fixture();
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(root, "feature.ts"), "feature");
    const head = commit(root);
    git(root, ["checkout", "-b", "trunk", base]);
    writeFileSync(path.join(root, "trunk.ts"), "trunk");
    const trunk = commit(root);
    const branch = await resolveBinding(repositoryId, root, {
      kind: "branch",
      name: "feature",
      baseRef: "trunk",
    });
    expect(branch).toMatchObject({
      repositoryId,
      baseCommit: base,
      headCommit: head,
    });
    const range = await resolveBinding(repositoryId, root, {
      kind: "range",
      baseRef: "trunk",
      headRef: "feature",
    });
    expect(range).toMatchObject({ baseCommit: trunk, headCommit: head });
    const snapshot = await resolveBinding(repositoryId, root, {
      kind: "snapshot",
      ref: "feature",
    });
    expect(snapshot).toMatchObject({ baseCommit: head, headCommit: head });
    expect(branch.id).not.toBe(range.id);
  });

  it("rejects unavailable, option-like and wrong-VCS selectors", async () => {
    const root = fixture();
    await expect(
      resolveBinding(repositoryId, root, { kind: "snapshot", ref: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      resolveBinding(repositoryId, root, { kind: "snapshot", ref: "--help" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      resolveBinding(repositoryId, root, {
        kind: "jj_change",
        changeId: "xyz",
        baseRef: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      resolveBinding(repositoryId, root, {
        kind: "pull_request",
        url: "https://example.com/owner/repo/pull/123",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("immutable local source queries", () => {
  it("returns the complete exact pinned file, including newline bytes, without reading the working copy", async () => {
    const root = fixture();
    const original = "first\r\nsecond\r\n";
    writeFileSync(path.join(root, "full.ts"), original);
    const oid = commit(root);
    const binding = await resolveBinding(repositoryId, root, {
      kind: "snapshot",
      ref: oid,
    });
    const source = new LocalRepositorySource(() => root);
    writeFileSync(path.join(root, "full.ts"), "uncommitted replacement");
    await expect(source.file(binding, "head", "full.ts")).resolves.toEqual({
      repositoryId,
      commit: oid,
      blob: git(root, ["rev-parse", `${oid}:full.ts`]),
      file: "full.ts",
      text: original,
      sha256: createHash("sha256").update(original).digest("hex"),
    });
    await expect(
      source.read(binding, {
        side: "head",
        file: "full.ts",
        fromLine: 1,
        toLine: 2,
      }),
    ).resolves.toMatchObject({ text: "first\nsecond" });
  });

  it("rejects unsafe full-file editor reads before exposing bytes", async () => {
    const root = fixture();
    writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(
      path.join(root, "invalid-utf8.txt"),
      Buffer.from([0xff, 0xfe]),
    );
    writeFileSync(path.join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
    symlinkSync("file.ts", path.join(root, "link"));
    const binding = await resolveBinding(repositoryId, root, {
      kind: "snapshot",
      ref: commit(root),
    });
    const source = new LocalRepositorySource(() => root);
    for (const file of ["binary.bin", "invalid-utf8.txt", "link"])
      await expect(source.file(binding, "head", file)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    await expect(
      source.file(binding, "head", "large.txt"),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(
      source.file(binding, "head", "../private"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      source.file(binding, "head", "missing.ts"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads trees and snippets from pinned commits after checkout edits", async () => {
    const root = fixture();
    const binding = await resolveBinding(repositoryId, root, {
      kind: "snapshot",
      ref: "HEAD",
    });
    const source = new LocalRepositorySource(() => root);
    writeFileSync(path.join(root, "file.ts"), "uncommitted");
    writeFileSync(path.join(root, "untracked.ts"), "untracked");
    expect(
      (await source.tree(binding, "head")).map((entry) => entry.path),
    ).toEqual(["file.ts"]);
    await expect(
      source.read(binding, {
        side: "head",
        file: "file.ts",
        fromLine: 1,
        toLine: 1,
      }),
    ).resolves.toMatchObject({ text: "header" });
    await expect(
      source.tree(binding, "head", "../outside"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("lists only immediate tree children and explicitly identifies symlinks", async () => {
    const root = fixture();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "child.ts"), "child");
    symlinkSync("file.ts", path.join(root, "link"));
    commit(root);
    const binding = await resolveBinding(repositoryId, root, {
      kind: "snapshot",
      ref: "HEAD",
    });
    const source = new LocalRepositorySource(() => root);
    expect(await source.tree(binding, "head")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src", kind: "directory" }),
        expect.objectContaining({ path: "link", kind: "symlink" }),
      ]),
    );
    expect(await source.tree(binding, "head", "src")).toEqual([
      expect.objectContaining({
        path: "src/child.ts",
        kind: "file",
        byteLength: 5,
      }),
    ]);
  });

  it("reports renamed files and changed lines in each side's coordinates", async () => {
    const root = fixture();
    const base = git(root, ["rev-parse", "HEAD"]);
    renameSync(path.join(root, "file.ts"), path.join(root, "renamed.ts"));
    writeFileSync(
      path.join(root, "renamed.ts"),
      `intro\nheader\nnewCall();\n${tail}`,
    );
    const head = commit(root);
    const binding = await resolveBinding(repositoryId, root, {
      kind: "range",
      baseRef: base,
      headRef: head,
    });
    const source = new LocalRepositorySource(() => root);
    expect(await source.diffFiles(binding)).toEqual([
      expect.objectContaining({
        path: "renamed.ts",
        previousPath: "file.ts",
        status: "renamed",
        additions: 2,
        deletions: 1,
        binary: false,
      }),
    ]);
    const oldLines = await source.changedLines(binding, "file.ts", "base");
    const newLines = await source.changedLines(binding, "renamed.ts", "head");
    expect([...oldLines!.deleted]).toEqual([2]);
    expect([...newLines!.added]).toEqual([1, 3]);
    await expect(
      source.changedLines(binding, "unchanged.ts", "head"),
    ).resolves.toBeNull();
    const history = await source.commits(binding);
    expect(history).toEqual([
      expect.objectContaining({
        oid: head,
        parents: [base],
        subject: "fixture",
      }),
    ]);
  });

  it("does not invoke repository-configured diff/textconv commands", async () => {
    const root = fixture();
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "file.ts"), `header\nnewCall();\n${tail}`);
    writeFileSync(path.join(root, ".gitattributes"), "*.ts diff=hostile\n");
    const head = commit(root);
    git(root, ["config", "diff.hostile.textconv", "false"]);
    git(root, ["config", "diff.external", "false"]);
    const binding = await resolveBinding(repositoryId, root, {
      kind: "range",
      baseRef: base,
      headRef: head,
    });
    const lines = await new LocalRepositorySource(() => root).changedLines(
      binding,
      "file.ts",
      "head",
    );
    expect([...lines!.added]).toEqual([2]);
    expect([...lines!.deleted]).toEqual([2]);
  });

  it("reports binary diff files without inventing changed source lines", async () => {
    const root = fixture();
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    const head = commit(root);
    const binding = await resolveBinding(repositoryId, root, {
      kind: "range",
      baseRef: base,
      headRef: head,
    });
    const source = new LocalRepositorySource(() => root);
    expect(await source.diffFiles(binding)).toEqual([
      expect.objectContaining({
        path: "binary.bin",
        binary: true,
        status: "added",
      }),
    ]);
    const lines = await source.changedLines(binding, "binary.bin", "head");
    expect(lines?.added.size).toBe(0);
  });
});

const tail =
  Array.from({ length: 15 }, (_, index) => `unchanged${index}();`).join("\n") +
  "\n";
function temp(): string {
  const root = mkdtempSync(path.join(tmpdir(), "host-repository-"));
  temporary.push(root);
  return root;
}

function hasJj(): boolean {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function fixture(): string {
  const root = temp();
  git(root, ["init", "-q"]);
  writeFileSync(path.join(root, "file.ts"), `header\noldCall();\n${tail}`);
  commit(root);
  return root;
}
function commit(root: string): string {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--no-verify", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}
function git(root: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Review Test",
      "-c",
      "user.email=review-test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("GIT_"),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}
