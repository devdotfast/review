import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitCommonDir } from "@dev.fast/local-vcs";
import type { HostBinding, HostSourceRange } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceProviderError,
  LocalEvidenceProvider,
} from "./evidence-provider";

const temporaryRoots: string[] = [];
const repositoryId = "0a411236-208c-41e7-80ba-0b32c06b37f9";

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("immutable source evidence", () => {
  it("quotes the pinned blob, not subsequent working-tree edits", async () => {
    const root = repository({ "src/example.ts": "header\r\none\r\ntwo\r\n" });
    const commit = git(root, ["rev-parse", "HEAD"]);
    const blob = git(root, ["rev-parse", `${commit}:src/example.ts`]);
    writeFileSync(
      path.join(root, "src/example.ts"),
      "uncommitted and unrelated\n",
    );

    const quote = await new LocalEvidenceProvider(() => root).resolve(
      binding(commit),
      {
        side: "head",
        file: "src/example.ts",
        fromLine: 2,
        toLine: 3,
      },
    );

    expect(quote).toEqual({
      span: {
        repositoryId,
        commit,
        blob,
        file: "src/example.ts",
        fromLine: 2,
        toLine: 3,
      },
      text: "one\ntwo",
      sha256: createHash("sha256").update("one\ntwo").digest("hex"),
    });
  });

  it("selects exact base/head paths across a rename", async () => {
    const root = repository({ "old name.ts": "base\n" });
    const base = git(root, ["rev-parse", "HEAD"]);
    renameSync(path.join(root, "old name.ts"), path.join(root, "new name.ts"));
    writeFileSync(path.join(root, "new name.ts"), "head\n");
    const head = commitAll(root);
    const provider = new LocalEvidenceProvider(() => root);

    await expect(
      provider.resolve(binding(base, head), range("old name.ts", "base")),
    ).resolves.toMatchObject({ text: "base", span: { commit: base } });
    await expect(
      provider.resolve(binding(base, head), range("new name.ts")),
    ).resolves.toMatchObject({ text: "head", span: { commit: head } });
    await expect(
      provider.resolve(binding(base, head), range("old name.ts")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("treats pathspec characters as literal filenames", async () => {
    const root = repository({
      "[one].ts": "literal",
      "o.ts": "wildcard match",
    });
    const quote = await new LocalEvidenceProvider(() => root).resolve(
      binding(git(root, ["rev-parse", "HEAD"])),
      range("[one].ts"),
    );
    expect(quote.text).toBe("literal");
  });

  it("reads a linked worktree's shared object database", async () => {
    const root = repository({ "file.ts": "retained evidence" });
    const commit = git(root, ["rev-parse", "HEAD"]);
    const worktree = path.join(temporaryDirectory(), "linked");
    git(root, ["worktree", "add", "--detach", worktree, commit]);
    writeFileSync(path.join(worktree, "file.ts"), "changed linked checkout");
    await expect(
      new LocalEvidenceProvider(() => worktree).resolve(
        binding(commit),
        range("file.ts"),
      ),
    ).resolves.toMatchObject({ text: "retained evidence" });
  });

  it("uses the inner Git-backed jj store rather than an enclosing repository", async () => {
    const outer = repository({ "file.ts": "outer repository" });
    const original = repository({ "file.ts": "inner repository" });
    const commit = git(original, ["rev-parse", "HEAD"]);
    const inner = path.join(outer, "inner");
    execFileSync("jj", ["git", "init", "--no-colocate", inner], {
      cwd: outer,
      stdio: "ignore",
    });
    const gitDir = await gitCommonDir(inner);
    expect(gitDir).toBeTruthy();
    execFileSync(
      "git",
      ["--git-dir", gitDir!, "fetch", "--no-tags", original, commit],
      { env: gitEnvironment(), stdio: "ignore" },
    );

    await expect(
      new LocalEvidenceProvider(() => inner).resolve(
        binding(commit),
        range("file.ts"),
      ),
    ).resolves.toMatchObject({ text: "inner repository", span: { commit } });
  });

  it("ignores replacement objects instead of changing what an old commit means", async () => {
    const root = repository({ "file.ts": "original" });
    const original = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "file.ts"), "replacement");
    const replacement = commitAll(root);
    git(root, ["replace", original, replacement]);

    await expect(
      new LocalEvidenceProvider(() => root).resolve(
        binding(original),
        range("file.ts"),
      ),
    ).resolves.toMatchObject({ text: "original" });
  });

  it("rejects missing files and unavailable commit objects", async () => {
    const root = repository({ "file.ts": "source" });
    const provider = new LocalEvidenceProvider(() => root);
    await expect(
      provider.resolve(
        binding(git(root, ["rev-parse", "HEAD"])),
        range("missing.ts"),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      provider.resolve(binding("0".repeat(40)), range("file.ts")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects blobs passed in place of exact commit IDs", async () => {
    const root = repository({ "file.ts": "source" });
    const blob = git(root, ["rev-parse", "HEAD:file.ts"]);
    await expect(
      new LocalEvidenceProvider(() => root).resolve(
        binding(blob),
        range("file.ts"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects symbolic and abbreviated revisions before accessing a repository", async () => {
    const provider = new LocalEvidenceProvider(() => {
      throw new Error("must not read repository");
    });
    for (const ref of ["HEAD", "abc123", "HEAD:file.ts", "--help"]) {
      await expect(
        provider.resolve(binding(ref), range("file.ts")),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it.each(["link", "module", "folder"])(
    "rejects a committed %s instead of following it",
    async (file) => {
      const root = repository({
        "file.ts": "source",
        "folder/file.ts": "nested",
      });
      symlinkSync("file.ts", path.join(root, "link"));
      git(root, ["add", "link"]);
      const previous = git(root, ["rev-parse", "HEAD"]);
      git(root, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${previous},module`,
      ]);
      git(root, ["commit", "--no-verify", "-m", "special entries"]);
      await expect(
        new LocalEvidenceProvider(() => root).resolve(
          binding(git(root, ["rev-parse", "HEAD"])),
          range(file),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    },
  );

  it.each([
    ["binary", Buffer.from([65, 0, 66])],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s source", async (_label, bytes) => {
    const root = repository({ "file.ts": bytes });
    await expect(
      new LocalEvidenceProvider(() => root).resolve(
        binding(git(root, ["rev-parse", "HEAD"])),
        range("file.ts"),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects oversized blobs even for a one-line quotation", async () => {
    const root = repository({ "file.ts": Buffer.alloc(1024 * 1024 + 1, 65) });
    await expect(
      new LocalEvidenceProvider(() => root).resolve(
        binding(git(root, ["rev-parse", "HEAD"])),
        range("file.ts"),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  it("bounds the quotation independently of the full file", async () => {
    const root = repository({
      "file.ts": `short\n${"x".repeat(256 * 1024 + 1)}`,
    });
    const provider = new LocalEvidenceProvider(() => root);
    const pinned = binding(git(root, ["rev-parse", "HEAD"]));
    await expect(
      provider.resolve(pinned, range("file.ts")),
    ).resolves.toMatchObject({ text: "short" });
    await expect(
      provider.resolve(pinned, { ...range("file.ts"), fromLine: 2, toLine: 2 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  it("does not invent a line after a terminating newline or in an empty file", async () => {
    const root = repository({ "file.ts": "one\n", "empty.ts": "" });
    const provider = new LocalEvidenceProvider(() => root);
    const pinned = binding(git(root, ["rev-parse", "HEAD"]));
    await expect(
      provider.resolve(pinned, { ...range("file.ts"), fromLine: 2, toLine: 2 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      provider.resolve(pinned, range("empty.ts")),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects invalid and oversized ranges before accessing a repository", async () => {
    const provider = new LocalEvidenceProvider(() => {
      throw new Error("must not read repository");
    });
    for (const [fromLine, toLine] of [
      [0, 1],
      [2, 1],
      [1.5, 2],
      [1, Number.NaN],
      [1, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      await expect(
        provider.resolve(binding("a".repeat(40)), {
          ...range("file.ts"),
          fromLine: fromLine!,
          toLine: toLine!,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(
      provider.resolve(binding("a".repeat(40)), {
        ...range("file.ts"),
        toLine: 1001,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  it.each([
    "../secret",
    "src/../secret",
    "/tmp/private",
    "C:/private",
    "src:private",
    "src\\file.ts",
    "src//file.ts",
    "./file.ts",
    "file.ts\0",
    "src/\nfile.ts",
  ])("rejects unsafe path %j before repository access", async (file) => {
    const provider = new LocalEvidenceProvider(() => {
      throw new Error("must not read repository");
    });
    await expect(
      provider.resolve(binding("a".repeat(40)), range(file)),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("returns sanitized typed errors for missing repositories", async () => {
    const privatePath = path.join(
      temporaryDirectory(),
      "missing-private-repository",
    );
    const providers = [
      new LocalEvidenceProvider(() => privatePath),
      new LocalEvidenceProvider(() => {
        throw new Error(`No repository at ${privatePath}`);
      }),
    ];
    for (const provider of providers) {
      const error = await provider
        .resolve(binding("a".repeat(40)), range("file.ts"))
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(EvidenceProviderError);
      expect(error).toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
        message: "The source repository is unavailable.",
      });
      expect(String(error)).not.toContain(privatePath);
    }
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "review-evidence-"));
  temporaryRoots.push(root);
  return root;
}

function repository(files: Record<string, string | Buffer>): string {
  const root = temporaryDirectory();
  git(root, ["init", "-q"]);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  commitAll(root);
  return root;
}

function commitAll(root: string): string {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--no-verify", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
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
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

function binding(baseCommit: string, headCommit = baseCommit): HostBinding {
  return {
    id: "a278a369-4e10-4e46-acaf-ab9397dcb51f",
    repositoryId,
    selector: { kind: "range", baseRef: baseCommit, headRef: headCommit },
    baseCommit,
    headCommit,
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

function range(file: string, side: "base" | "head" = "head"): HostSourceRange {
  return { side, file, fromLine: 1, toLine: 1 };
}
