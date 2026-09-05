import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  disableAllTraceRepositories,
  disableTraceRepository,
  enableTraceRepository,
  traceRepositoryStatus,
} from "./trace-repository-hooks";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("trace repository hooks", () => {
  it("chains and restores the repository's existing hook path", async () => {
    const { homeDir, repo } = await makeRepository();
    await runGit(repo, ["config", "--local", "core.hooksPath", ".husky/_"]);

    const first = await enableTraceRepository({
      cwd: repo,
      homeDir,
      reviewCommand: "/opt/review/bin/review",
    });
    const second = await enableTraceRepository({
      cwd: repo,
      homeDir,
      reviewCommand: "/opt/review/bin/review",
    });

    expect(first.enabled).toBe(true);
    expect(second.managedHooksPath).toBe(first.managedHooksPath);
    expect(await runGit(repo, ["config", "--get", "core.hooksPath"])).toBe(
      first.managedHooksPath,
    );
    expect(
      await readFile(path.join(first.managedHooksPath!, "pre-push"), "utf8"),
    ).toContain(".husky/_/pre-push");
    expect((await traceRepositoryStatus(repo)).enabled).toBe(true);

    await disableTraceRepository({ cwd: repo, homeDir });

    expect(await runGit(repo, ["config", "--get", "core.hooksPath"])).toBe(
      ".husky/_",
    );
  });

  it("does not replace a hook path that changed after activation", async () => {
    const { homeDir, repo } = await makeRepository();
    await enableTraceRepository({
      cwd: repo,
      homeDir,
      reviewCommand: "review",
    });
    await runGit(repo, [
      "config",
      "--local",
      "core.hooksPath",
      ".custom-hooks",
    ]);

    await disableTraceRepository({ cwd: repo, homeDir });

    expect(await runGit(repo, ["config", "--get", "core.hooksPath"])).toBe(
      ".custom-hooks",
    );
  });

  it("disables repositories registered under TRACE_HOME_DIR when no homeDir is given", async () => {
    const traceHome = await mkdtemp(
      path.join(os.tmpdir(), "trace-hooks-trace-home-"),
    );
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "trace-hooks-home-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "trace-hooks-repo-"));
    roots.push(traceHome, homeDir, repo);
    await runGit(repo, ["init", "-b", "main"]);

    const prevHome = process.env.HOME;
    const prevTrace = process.env.TRACE_HOME_DIR;
    process.env.HOME = homeDir;
    process.env.TRACE_HOME_DIR = traceHome;
    try {
      const enabled = await enableTraceRepository({
        cwd: repo,
        reviewCommand: "review",
      });
      expect(enabled.enabled).toBe(true);
      expect((await traceRepositoryStatus(repo)).enabled).toBe(true);

      const traceRegistry = path.join(
        traceHome,
        ".config",
        "dev-trace",
        "repositories.json",
      );
      const homeRegistry = path.join(
        homeDir,
        ".config",
        "dev-trace",
        "repositories.json",
      );
      expect(await readFile(traceRegistry, "utf8")).toContain(repo);
      await expect(readFile(homeRegistry, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await disableAllTraceRepositories();

      expect((await traceRepositoryStatus(repo)).enabled).toBe(false);
    } finally {
      process.env.HOME = prevHome;
      if (prevTrace === undefined) delete process.env.TRACE_HOME_DIR;
      else process.env.TRACE_HOME_DIR = prevTrace;
    }
  });
});

async function makeRepository(): Promise<{ homeDir: string; repo: string }> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "trace-hooks-home-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "trace-hooks-repo-"));
  roots.push(homeDir, repo);
  await runGit(repo, ["init", "-b", "main"]);
  return { homeDir, repo };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}
