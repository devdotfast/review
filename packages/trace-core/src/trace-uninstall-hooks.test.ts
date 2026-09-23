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

it("releases Review hooks across registered repositories while preserving login and the CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "trace-release-"));
  roots.push(home);
  const devHome = path.join(home, "profile");

  const scope = traceScope({
    homeDir: home,
    env: { DEV_WHITEBOARD_HOME: devHome },
  });

  const review = path.join(home, ".local/bin/review");
  await mkdir(path.dirname(review), { recursive: true });
  await writeFile(review, "#!/bin/sh\n# Managed by Review Desktop\n", {
    mode: 0o755,
  });
  await mkdir(devHome, { recursive: true });
  await writeFile(path.join(devHome, "auth.json"), "keep-login");
  await installClaudeTraceHook(home, review);
  await installCodexTraceHook(home, review);
  const repositories = [];

  for (const owner of [review, review]) {
    const repo = path.join(home, String(repositories.length));
    await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    await enableTraceRepository({ cwd: repo, scope, reviewCommand: owner });
    repositories.push(repo);
  }

  const output = collectingWritable([]);
  expect(
    await runTraceUninstallHooks({
      scope,
      stdout: output,
      stderr: output,
    }),
  ).toBe(0);
  expect(await describeTraceHookOwners(home)).toMatchObject({
    claude: null,
    codex: null,
  });
  expect((await traceRepositoryStatus(repositories[0]!)).enabled).toBe(false);
  expect((await traceRepositoryStatus(repositories[1]!)).enabled).toBe(false);
  expect(existsSync(review)).toBe(true);
  expect(await readFile(path.join(devHome, "auth.json"), "utf8")).toBe(
    "keep-login",
  );
  expect(
    await runTraceUninstallHooks({
      scope,
      stdout: output,
      stderr: output,
    }),
  ).toBe(0);
});
