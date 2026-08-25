import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  resolveReviewDiffFiles,
  resolveReviewFileContent,
} from "./review-diff-files";

describe("resolveReviewDiffFiles", () => {
  test("falls back to jj for unexported jj commits", async () => {
    if (!commandExists("jj")) {
      return;
    }

    const rootPath = await mkdtemp(path.join(os.tmpdir(), "review-diff-jj-"));
    try {
      execJj(rootPath, ["git", "init"]);
      await mkdir(path.join(rootPath, "src"), { recursive: true });
      await writeFile(
        path.join(rootPath, "src/example.ts"),
        "export const value = 1;\n",
      );
      const baseRef = execJjOutput(rootPath, [
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        "change_id.short()",
      ]);
      execJj(rootPath, ["new"]);
      await writeFile(
        path.join(rootPath, "src/example.ts"),
        "export const value = 2;\n",
      );
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

      const result = await resolveReviewDiffFiles({
        rootPath,
        baseRef,
        headRef,
      });

      expect(result.files).toMatchObject([
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ]);
      expect(result.files[0]?.patch).toContain("-export const value = 1;");
      expect(result.files[0]?.patch).toContain("+export const value = 2;");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("limits parsed diff files to requested paths", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "review-diff-git-"));
    try {
      execGit(rootPath, ["init"]);
      execGit(rootPath, ["config", "user.email", "test@example.com"]);
      execGit(rootPath, ["config", "user.name", "Test User"]);
      await mkdir(path.join(rootPath, "src"), { recursive: true });
      await writeFile(
        path.join(rootPath, "src/visible.ts"),
        "export const visible = 1;\n",
      );
      await writeFile(
        path.join(rootPath, "src/hidden.ts"),
        "export const hidden = 1;\n",
      );
      execGit(rootPath, ["add", "src/visible.ts", "src/hidden.ts"]);
      execGit(rootPath, ["commit", "-m", "initial"]);
      const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeFile(
        path.join(rootPath, "src/visible.ts"),
        "export const visible = 2;\n",
      );
      await writeFile(
        path.join(rootPath, "src/hidden.ts"),
        "export const hidden = 2;\n",
      );
      execGit(rootPath, ["add", "src/visible.ts", "src/hidden.ts"]);
      execGit(rootPath, ["commit", "-m", "change"]);
      const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      const result = await resolveReviewDiffFiles({
        rootPath,
        baseRef,
        headRef,
        paths: ["src/visible.ts"],
      });

      expect(result.files.map((file) => file.path)).toEqual(["src/visible.ts"]);
      expect(result.files[0]?.patch).toContain("+export const visible = 2;");
      expect(result.files[0]?.patch).not.toContain("hidden");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("can return file summaries without patch bodies", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "review-diff-git-"));
    try {
      execGit(rootPath, ["init"]);
      execGit(rootPath, ["config", "user.email", "test@example.com"]);
      execGit(rootPath, ["config", "user.name", "Test User"]);
      await mkdir(path.join(rootPath, "src"), { recursive: true });
      await writeFile(
        path.join(rootPath, "src/example.ts"),
        "export const value = 1;\n",
      );
      execGit(rootPath, ["add", "src/example.ts"]);
      execGit(rootPath, ["commit", "-m", "initial"]);
      const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeFile(
        path.join(rootPath, "src/example.ts"),
        "export const value = 2;\n",
      );
      execGit(rootPath, ["add", "src/example.ts"]);
      execGit(rootPath, ["commit", "-m", "change"]);
      const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      const result = await resolveReviewDiffFiles({
        rootPath,
        baseRef,
        headRef,
        includePatch: false,
      });

      expect(result.files).toEqual([
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("can request enough context for declaration-shaped CodePeek patches", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "review-diff-git-"));
    try {
      execGit(rootPath, ["init"]);
      execGit(rootPath, ["config", "user.email", "test@example.com"]);
      execGit(rootPath, ["config", "user.name", "Test User"]);
      await mkdir(path.join(rootPath, "src"), { recursive: true });
      await writeFile(
        path.join(rootPath, "src/example.ts"),
        [
          "export function target() {",
          "  const one = 1;",
          "  const two = 2;",
          "  const three = 3;",
          "  const four = 4;",
          "  return one + two + three + four;",
          "}",
          "",
        ].join("\n"),
      );
      execGit(rootPath, ["add", "src/example.ts"]);
      execGit(rootPath, ["commit", "-m", "initial"]);
      const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      await writeFile(
        path.join(rootPath, "src/example.ts"),
        [
          "export function target() {",
          "  const one = 1;",
          "  const two = 2;",
          "  const three = 30;",
          "  const four = 4;",
          "  return one + two + three + four;",
          "}",
          "",
        ].join("\n"),
      );
      execGit(rootPath, ["add", "src/example.ts"]);
      execGit(rootPath, ["commit", "-m", "change"]);
      const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      const narrow = await resolveReviewDiffFiles({
        rootPath,
        baseRef,
        headRef,
        paths: ["src/example.ts"],
        contextLines: 1,
      });
      const wide = await resolveReviewDiffFiles({
        rootPath,
        baseRef,
        headRef,
        paths: ["src/example.ts"],
        contextLines: 100,
      });

      expect(narrow.files[0]?.patch).not.toContain(
        "\n export function target()",
      );
      expect(wide.files[0]?.patch).toContain("\n export function target()");
      expect(wide.files[0]?.patch).toContain("+  const three = 30;");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test("serves pinned modified, added, deleted, and renamed diff sides", async () => {
    const fixture = await createFileContentFixture();
    try {
      const { rootPath, baseRef, headRef } = fixture;
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          headRef,
          path: "src/modified.ts",
          side: "base",
        }),
      ).resolves.toEqual({ content: "export const modified = 'base';\n" });
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          headRef,
          path: "src/modified.ts",
          side: "head",
        }),
      ).resolves.toEqual({ content: "export const modified = 'head';\n" });
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          headRef,
          path: "src/added.ts",
          side: "base",
        }),
      ).resolves.toEqual({ absent: true });
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          headRef,
          path: "src/deleted.ts",
          side: "head",
        }),
      ).resolves.toEqual({ absent: true });
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          headRef,
          path: "src/renamed.ts",
          side: "base",
        }),
      ).resolves.toEqual({ content: "export const renamed = 'same';\n" });
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          headRef,
          path: "../outside.ts",
          side: "head",
        }),
      ).rejects.toThrow("not present in the current diff");
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test("reuses a precomputed comparison when reading file content", async () => {
    const fixture = await createFileContentFixture();
    try {
      const comparison = await resolveReviewDiffFiles({
        rootPath: fixture.rootPath,
        baseRef: fixture.baseRef,
        headRef: fixture.headRef,
      });
      await expect(
        resolveReviewFileContent({
          rootPath: fixture.rootPath,
          baseRef: "missing-base",
          headRef: "missing-head",
          path: "src/modified.ts",
          side: "head",
          comparison,
        }),
      ).resolves.toEqual({ content: "export const modified = 'head';\n" });
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test("reads the live working-tree head while keeping the base pinned", async () => {
    const fixture = await createFileContentFixture();
    try {
      execGit(fixture.rootPath, ["reset", "--hard", fixture.baseRef]);
      await writeFile(
        path.join(fixture.rootPath, "src/modified.ts"),
        "export const modified = 'working tree';\n",
      );
      execGit(fixture.rootPath, ["add", "src/modified.ts"]);

      await expect(
        resolveReviewFileContent({
          rootPath: fixture.rootPath,
          baseRef: fixture.baseRef,
          path: "src/modified.ts",
          side: "head",
        }),
      ).resolves.toEqual({
        content: "export const modified = 'working tree';\n",
      });
      await expect(
        resolveReviewFileContent({
          rootPath: fixture.rootPath,
          baseRef: fixture.baseRef,
          path: "src/modified.ts",
          side: "base",
        }),
      ).resolves.toEqual({ content: "export const modified = 'base';\n" });
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  test("reports binary and capped content without exposing arbitrary files", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-content-git-"),
    );
    try {
      execGit(rootPath, ["init"]);
      execGit(rootPath, ["config", "user.email", "test@example.com"]);
      execGit(rootPath, ["config", "user.name", "Test User"]);
      await writeFile(path.join(rootPath, "example.dat"), "base\n");
      execGit(rootPath, ["add", "example.dat"]);
      execGit(rootPath, ["commit", "-m", "initial"]);
      const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeFile(
        path.join(rootPath, "example.dat"),
        Buffer.from([0, 1, 2]),
      );
      execGit(rootPath, ["add", "example.dat"]);
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          path: "example.dat",
          side: "head",
        }),
      ).resolves.toEqual({ binary: true });

      await writeFile(path.join(rootPath, "example.dat"), "0123456789");
      await expect(
        resolveReviewFileContent({
          rootPath,
          baseRef,
          path: "example.dat",
          side: "head",
          maxBytes: 5,
        }),
      ).resolves.toEqual({ content: "01234", truncated: true });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

async function createFileContentFixture(): Promise<{
  rootPath: string;
  baseRef: string;
  headRef: string;
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "review-content-git-"));
  execGit(rootPath, ["init"]);
  execGit(rootPath, ["config", "user.email", "test@example.com"]);
  execGit(rootPath, ["config", "user.name", "Test User"]);
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(rootPath, "src/modified.ts"),
      "export const modified = 'base';\n",
    ),
    writeFile(
      path.join(rootPath, "src/deleted.ts"),
      "export const deleted = true;\n",
    ),
    writeFile(
      path.join(rootPath, "src/old-name.ts"),
      "export const renamed = 'same';\n",
    ),
  ]);
  execGit(rootPath, ["add", "src"]);
  execGit(rootPath, ["commit", "-m", "initial"]);
  const baseRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
  await Promise.all([
    writeFile(
      path.join(rootPath, "src/modified.ts"),
      "export const modified = 'head';\n",
    ),
    writeFile(
      path.join(rootPath, "src/added.ts"),
      "export const added = true;\n",
    ),
    unlink(path.join(rootPath, "src/deleted.ts")),
    rename(
      path.join(rootPath, "src/old-name.ts"),
      path.join(rootPath, "src/renamed.ts"),
    ),
  ]);
  execGit(rootPath, ["add", "src"]);
  execGit(rootPath, ["commit", "-m", "change"]);
  const headRef = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
  return { rootPath, baseRef, headRef };
}

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
