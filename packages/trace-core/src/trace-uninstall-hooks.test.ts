import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  describeTraceHookOwners,
  installClaudeTraceHook,
  installCodexTraceHook,
} from "./agent-trace-hooks";
import { collectingWritable } from "./cli-output";
import { traceScope } from "./trace-command";
import {
  desktopTraceCommand,
  setTraceHooksDisabled,
  traceHooksDisabled,
} from "./trace-hook-ownership";
import {
  enableTraceRepository,
  traceRepositoryStatus,
} from "./trace-repository-hooks";
import { runTraceUninstallHooks } from "./trace-uninstall-hooks";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

it("releases only Review hooks across registered repositories, preserving standalone and user state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "trace-release-"));
  roots.push(home);
  const devHome = path.join(home, "profile");

  const scope = traceScope({
    homeDir: home,
    env: { DEV_REVIEW_HOME: devHome },
  });

  const review = path.join(home, ".local/bin/review");
  const standalone = path.join(home, ".local/bin/dev-traces");
  await mkdir(path.dirname(review), { recursive: true });
  await writeFile(review, "#!/bin/sh\n# Managed by Review Desktop\n", {
    mode: 0o755,
  });
  await writeFile(standalone, "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(devHome, { recursive: true });
  await writeFile(path.join(devHome, "auth.json"), "keep-login");
  await installClaudeTraceHook(home, review);
  await installCodexTraceHook(home, standalone);
  const repositories = [];

  for (const owner of [review, standalone]) {
    const repo = path.join(home, String(repositories.length));
    await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    await enableTraceRepository({ cwd: repo, scope, reviewCommand: owner });
    repositories.push(repo);
  }

  expect(desktopTraceCommand(home)).toBe(review);
  const output = collectingWritable([]);
  expect(
    await runTraceUninstallHooks({
      scope,
      cwd: home,
      owner: "review",
      stdout: output,
      stderr: output,
    }),
  ).toBe(0);
  expect(await describeTraceHookOwners(home)).toMatchObject({
    claude: null,
    codex: "dev-traces",
  });
  expect((await traceRepositoryStatus(repositories[0]!)).enabled).toBe(false);
  expect((await traceRepositoryStatus(repositories[1]!)).enabled).toBe(true);
  expect(existsSync(review)).toBe(true);
  expect(await readFile(path.join(devHome, "auth.json"), "utf8")).toBe(
    "keep-login",
  );
  expect(traceHooksDisabled("review", home)).toBe(true);
  expect(desktopTraceCommand(home)).toBeNull();
  expect(
    await runTraceUninstallHooks({
      scope,
      cwd: home,
      owner: "review",
      stdout: output,
      stderr: output,
    }),
  ).toBe(0);
  await setTraceHooksDisabled("review", home, false);
  expect(desktopTraceCommand(home)).toBe(review);
});
