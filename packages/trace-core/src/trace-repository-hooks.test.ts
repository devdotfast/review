import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { traceScope } from "./trace-command";
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
  it("renders a file with arguments as separate words and records the command", async () => {
    const { homeDir, repo } = await makeRepository();

    const enabled = await enableTraceRepository({
      cwd: repo,
      scope: traceScope({ homeDir }),
      reviewCommand: {
        file: "/opt/dev traces/dev-traces",
        args: ["--home", "/x"],
      },
    });

    const rendered = "'/opt/dev traces/dev-traces' '--home' '/x'";
    expect(enabled.command).toBe(rendered);
    expect(
      await readFile(path.join(enabled.managedHooksPath!, "pre-push"), "utf8"),
    ).toContain(`${rendered} trace git-hook pre-push "$@"`);
    expect(
      JSON.parse(
        await readFile(
          path.join(repo, ".git", "dev-fast", "trace-hooks", "state.json"),
          "utf8",
        ),
      ).command,
    ).toBe(rendered);
    expect((await traceRepositoryStatus(repo)).command).toBe(rendered);

    const repaired = await enableTraceRepository({
      cwd: repo,
      scope: traceScope({ homeDir }),
      reviewCommand: "review",
    });

    expect(repaired.command).toBe("'review'");
    expect(
      await readFile(path.join(enabled.managedHooksPath!, "pre-push"), "utf8"),
    ).toContain(`'review' trace git-hook pre-push`);
  });

  it("chains and restores the repository's existing hook path", async () => {
    const { homeDir, repo } = await makeRepository();
    await runGit(repo, ["config", "--local", "core.hooksPath", ".husky/_"]);

    const first = await enableTraceRepository({
      cwd: repo,
      scope: traceScope({ homeDir }),
      reviewCommand: "/opt/review/bin/review",
    });

    const second = await enableTraceRepository({
      cwd: repo,
      scope: traceScope({ homeDir }),
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

    await disableTraceRepository({ cwd: repo, scope: traceScope({ homeDir }) });

    expect(await runGit(repo, ["config", "--get", "core.hooksPath"])).toBe(
      ".husky/_",
    );
  });

  it("does not replace a hook path that changed after activation", async () => {
    const { homeDir, repo } = await makeRepository();
    await enableTraceRepository({
      cwd: repo,
      scope: traceScope({ homeDir }),
      reviewCommand: "review",
    });
    await runGit(repo, [
      "config",
      "--local",
      "core.hooksPath",
      ".custom-hooks",
    ]);

    await disableTraceRepository({ cwd: repo, scope: traceScope({ homeDir }) });

    expect(await runGit(repo, ["config", "--get", "core.hooksPath"])).toBe(
      ".custom-hooks",
    );
  });

  it("leaves the repositories of the other CLI enabled when an owner is named", async () => {
    const { homeDir, repo: reviewRepo } = await makeRepository();

    const tracesRepo = await mkdtemp(
      path.join(os.tmpdir(), "trace-hooks-repo-"),
    );

    roots.push(tracesRepo);
    await runGit(tracesRepo, ["init", "-b", "main"]);
    const scope = traceScope({ homeDir });

    await enableTraceRepository({
      cwd: reviewRepo,
      scope,
      reviewCommand: "/opt/review/review",
    });
    await enableTraceRepository({
      cwd: tracesRepo,
      scope,
      reviewCommand: "/opt/traces/dev-traces",
    });

    const { kept } = await disableAllTraceRepositories(scope, {
      owner: "review",
    });

    expect(kept).toEqual([(await traceRepositoryStatus(tracesRepo)).root]);
    expect((await traceRepositoryStatus(reviewRepo)).enabled).toBe(false);
    expect((await traceRepositoryStatus(tracesRepo)).enabled).toBe(true);

    await disableAllTraceRepositories(scope);

    expect((await traceRepositoryStatus(tracesRepo)).enabled).toBe(false);
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
