import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { checkProductionDependencies } from "./whiteboard-cli-dependencies.mjs";

const exec = promisify(execFile);

const tarball = path.resolve(process.argv[2]);

const expectedVersion = process.argv[3];

const root = await mkdtemp(path.join(os.tmpdir(), "review-cli-smoke-"));

let server;

let exited;

try {
  // No workspace modules, Desktop, display, or account state are available to the installed CLI.
  const prefix = path.join(root, "install");
  await mkdir(prefix);
  await copyFile(tarball, path.join(prefix, "review.tgz"));
  await exec("npm", ["install", "--no-audit", "--no-fund", "./review.tgz"], {
    cwd: prefix,
    maxBuffer: 16 * 1024 * 1024,
  });

  const dependencyTree = JSON.parse(
    (
      await exec("npm", ["ls", "--all", "--omit=dev", "--json"], {
        cwd: prefix,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout,
  );

  const dependencyCount = checkProductionDependencies(dependencyTree);
  console.log(
    `Production dependency audit passed (${dependencyCount} unique packages).`,
  );
  const pkgRoot = path.join(prefix, "node_modules/@dev.fast/whiteboard");

  const pkg = JSON.parse(
    await readFile(path.join(pkgRoot, "package.json"), "utf8"),
  );

  assert.equal(pkg.version, expectedVersion);
  assert.match(pkg.gitHead, /^[a-f0-9]{40}$/);

  const build = JSON.parse(
    await readFile(path.join(pkgRoot, "dist/build-info.json"), "utf8"),
  );

  assert.equal(build.version, expectedVersion);
  assert.equal(build.commit, pkg.gitHead);

  for (const file of [
    "dist/whiteboard-cli.js",
    "skills/whiteboard/docs/README.md",
    "skills/trace-archaeology/SKILL.md",
    "instructions/authoring-live.md",
    "instructions/authoring-batch.md",
    "instructions/document-authoring.md",
    "instructions/headless.md",
    "instructions/prepared-worktrees.md",
    "instructions/scratchpad.md",
    "instructions/trace-archaeology.md",
  ])
    await access(path.join(pkgRoot, file));
  await assert.rejects(access(path.join(pkgRoot, "app")));
  assert.match(
    await readFile(path.join(pkgRoot, "skills/whiteboard/SKILL.md"), "utf8"),
    new RegExp(
      `whiteboard-version: "${expectedVersion.replaceAll(".", "\\.")}"`,
    ),
  );
  const cli = path.join(prefix, "node_modules/.bin/whiteboard");

  const env = {
    ...process.env,
    PATH: `${path.join(prefix, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE: "1",
    DEV_WHITEBOARD_HOME: path.join(root, "profile"),
    DEV_WHITEBOARD_SERVER_DIR: path.join(root, "server"),
    TRACE_HOME_DIR: path.join(root, "home"),
  };

  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;

  const run = async (args) =>
    (
      await exec(cli, args, {
        cwd: root,
        env,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;

  const api = async (name, value = {}) =>
    JSON.parse(await run(["api", name, JSON.stringify(value)]));

  const installed = JSON.parse(
    await run(["trace", "install", "--all-harnesses", "--json"]),
  );

  assert.equal(installed.hooks.length, 4);

  const hooks = JSON.parse(
    await readFile(
      path.join(env.TRACE_HOME_DIR, ".claude/settings.json"),
      "utf8",
    ),
  );

  assert.ok(
    hooks.hooks.SessionStart[0].hooks[0].command.includes(cli),
    "Hooks must use the installed npm executable, not a host Desktop launcher",
  );
  const removed = JSON.parse(await run(["trace", "uninstall-hooks", "--json"]));
  assert.equal(removed.removed.length, 4);
  server = spawn(cli, ["server", "start", "--json"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  exited = new Promise((resolve) => {
    server.once("exit", resolve);
    server.once("error", resolve);
  });
  let ready = false;

  for (let i = 0; i < 60; i++) {
    try {
      await run(["server", "status", "--json"]);
      ready = true;
      break;
    } catch {
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error("Headless server exited before readiness");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  assert.ok(ready, "Headless server must become ready");
  const repository = path.join(root, "repository");
  await mkdir(repository);
  const git = (...args) => exec("git", args, { cwd: repository });
  await git("init", "-q");
  await writeFile(path.join(repository, "answer.txt"), "42\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.com",
    "commit",
    "-qm",
    "fixture",
  );
  const head = (await git("rev-parse", "HEAD")).stdout.trim();

  const registered = await api("session_register_repository", {
    path: repository,
  });

  const pins = await api("session_resolve_pins", {
    repositoryId: registered.id,
    base: head,
    head,
  });

  const created = await api("session_create", {
    commandId: randomUUID(),
    title: "Packed CLI smoke",
    target: { kind: "commits", ...pins },
    open: false,
  });

  const lease = { sessionId: created.sessionId, leaseId: randomUUID() };
  await api("session_activity", { ...lease, action: "begin" });
  await api("session_edit", {
    ...lease,
    commandId: randomUUID(),
    edit: {
      type: "insert",
      content: {
        type: "section",
        title: "Summary",
        children: [
          {
            type: "markdown",
            markdown: "The installed CLI can author reviews.",
          },
        ],
      },
    },
  });
  await api("session_activity", { ...lease, action: "end" });
  const reviews = await api("session_list");
  assert.equal(reviews.length, 1);
  console.log(
    `Installed ${pkg.name}@${pkg.version}: tracing and headless authoring passed without Desktop.`,
  );
} finally {
  if (server) {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }

  await rm(root, { recursive: true, force: true });
}
