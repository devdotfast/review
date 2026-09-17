import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { diffWorkingTree } from "./index";

it.each([false, true])(
  "diffs final working bytes without modifying repository state (split index: %s)",
  async (splitIndex) => {
    const root = await mkdtemp(path.join(tmpdir(), "working-diff-test-"));

    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

    try {
      git("init", "-q");
      git("config", "core.filemode", "true");

      for (const [file, content] of Object.entries({
        "old.ts": "export const value = 1;\n".repeat(20),
        "edit.ts": "base\n",
        "delete.ts": "delete\n",
        "mode.sh": "echo hi\n",
        binary: "\0base",
        "restore.ts": "original\n",
        ".gitignore": "ignored\n",
      }))
        await writeFile(path.join(root, file), content);
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "base",
      );
      const baseRef = git("rev-parse", "HEAD");
      await writeFile(path.join(root, "edit.ts"), "staged\n");
      git("add", "edit.ts");
      await writeFile(path.join(root, "edit.ts"), "working\n");
      await rename(path.join(root, "old.ts"), path.join(root, "new.ts"));
      await rm(path.join(root, "delete.ts"));
      await chmod(path.join(root, "mode.sh"), 0o755);
      await writeFile(path.join(root, "binary"), "\0changed");
      await writeFile(path.join(root, "empty"), "");
      await writeFile(path.join(root, "new [file].ts"), "new\n");
      await writeFile(path.join(root, "ignored"), "hidden\n");
      await symlink("edit.ts", path.join(root, "link"));
      git("rm", "-q", "restore.ts");
      await writeFile(path.join(root, "restore.ts"), "recreated\n");

      if (splitIndex) {
        git("config", "core.splitIndex", "true");
        git("update-index", "--split-index");
      }

      const gitFiles = await readdir(path.join(root, ".git"), {
        recursive: true,
      });

      const index = await readFile(path.join(root, ".git/index"));
      const refs = git("show-ref");

      const objects = await readdir(path.join(root, ".git/objects"), {
        recursive: true,
      });

      const input = { rootPath: root, kind: "git" as const, baseRef };
      const changes = await diffWorkingTree(input);
      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "new.ts",
            previousPath: "old.ts",
            status: "renamed",
          }),
          expect.objectContaining({
            path: "empty",
            status: "added",
            additions: 0,
          }),
          expect.objectContaining({
            path: "binary",
            status: "modified",
            additions: 0,
          }),
          expect.objectContaining({ path: "delete.ts", status: "deleted" }),
          expect.objectContaining({ path: "link", status: "added" }),
          expect.objectContaining({ path: "restore.ts", status: "modified" }),
        ]),
      );
      expect(changes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "ignored" })]),
      );
      expect(await diffWorkingTree({ ...input, file: "new.ts" })).toContain(
        "rename from old.ts",
      );
      expect(await diffWorkingTree({ ...input, file: "mode.sh" })).toContain(
        "new mode 100755",
      );
      expect(await diffWorkingTree({ ...input, file: "edit.ts" })).toContain(
        "+working",
      );
      expect(
        await diffWorkingTree({ ...input, file: "new [file].ts" }),
      ).toContain("+new");
      expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
      expect(git("show-ref")).toBe(refs);
      expect(
        await readdir(path.join(root, ".git/objects"), { recursive: true }),
      ).toEqual(objects);
      expect(
        await readdir(path.join(root, ".git"), { recursive: true }),
      ).toEqual(gitFiles);
      await mkdir(path.join(root, "linked"));
      git("worktree", "add", "--detach", path.join(root, "linked"), baseRef);
      await writeFile(path.join(root, "linked", "extra.ts"), "linked\n");
      expect(
        await diffWorkingTree({
          ...input,
          rootPath: path.join(root, "linked"),
        }),
      ).toEqual([
        expect.objectContaining({ path: "extra.ts", status: "added" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
