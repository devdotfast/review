import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parse } from "smol-toml";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  reviewMcpLauncher,
  reviewMcpRegistration,
  writeReviewMcpRegistration,
} from "./agent-review-mcp";
import {
  applyCliInstall,
  cliInstallStampPath,
  readCliInstallStamp,
  removeCliInstall,
  resolveCliInstallStatus,
} from "./cli-install";

let homeDir: string;

let env: NodeJS.ProcessEnv;

let cliPath: string;

const packageRoot = path.resolve(import.meta.dirname, "..");

const targets = ["codex", "claude"] as const;

const install = (autoUpdate = false) =>
  applyCliInstall({
    packageRoot,
    targets: [...targets],
    homeDir,
    env,
    cliPath,
    cliRuntimePath: process.execPath,
    autoUpdate,
  });

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "review-mcp-install-"));
  env = {
    DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
  };
  cliPath = path.join(homeDir, "cli.cjs");
  await writeFile(
    cliPath,
    "console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.DEV_REVIEW_HOME,serverDir:process.env.DEV_REVIEW_SERVER_DIR,build:1}));",
  );
});

afterEach(() => rm(homeDir, { recursive: true, force: true }));

async function config(target: (typeof targets)[number]) {
  const file = reviewMcpRegistration(target, homeDir, env).configPath;
  const text = await readFile(file, "utf8");

  return target === "codex" ? parse(text) : JSON.parse(text);
}

it("installs both agents without their CLIs, preserves other settings, and launches the selected app profile", async () => {
  await mkdir(path.join(homeDir, ".codex"));

  const original =
    '# Keep my preferences\nmodel = "chosen-model"\n[mcp_servers.other]\ncommand = "other"\n';

  await writeFile(path.join(homeDir, ".codex/config.toml"), original);
  await writeFile(
    path.join(homeDir, ".claude.json"),
    JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "other" } },
    }),
  );
  expect((await install()).code).toBe(0);

  const before = await readFile(
    path.join(homeDir, ".codex/config.toml"),
    "utf8",
  );

  expect(before.startsWith(original)).toBe(true);
  expect((await config("claude")).mcpServers.other).toEqual({
    command: "other",
  });
  expect((await config("codex")).model).toBe("chosen-model");
  const registration = (await config("claude")).mcpServers.whiteboard;

  const { stdout } = await promisify(execFile)(
    registration.command,
    registration.args,
    {
      env: {
        ...env,
        DEV_REVIEW_SERVER_DIR: path.join(homeDir, "other-headless-server"),
        ...registration.env,
      },
    },
  );

  expect(JSON.parse(stdout)).toEqual({
    args: ["mcp"],
    home: env.DEV_REVIEW_HOME,
    serverDir: "",
    build: 1,
  });
  expect((await install()).code).toBe(0);
  expect(await readFile(path.join(homeDir, ".codex/config.toml"), "utf8")).toBe(
    before,
  );
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.map(
      (item) => item.state,
    ),
  ).toEqual(["ready", "ready"]);
});

it("repairs missing registrations and launcher automatically for a previously enabled install", async () => {
  await install();
  await rm(path.join(homeDir, ".codex/config.toml"));
  await rm(reviewMcpLauncher(env));
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).stale,
  ).toBe(true);
  expect((await install(true)).code).toBe(0);
  expect((await config("codex")).mcp_servers).toHaveProperty("whiteboard");
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).stale,
  ).toBe(false);
});

it("upgrades an older skills-only install and refreshes the launcher when the app moves", async () => {
  await install();
  const stamp = (await readCliInstallStamp(cliInstallStampPath(env)))!;
  delete stamp.mcpRegistrations;
  await writeFile(cliInstallStampPath(env), JSON.stringify(stamp));
  await rm(path.join(homeDir, ".codex/config.toml"));
  await rm(path.join(homeDir, ".claude.json"));
  const newCli = path.join(homeDir, "new-build.cjs");
  await writeFile(newCli, 'console.log("new-build");');
  cliPath = newCli;
  expect((await install(true)).code).toBe(0);
  const registration = (await config("claude")).mcpServers.whiteboard;

  const { stdout } = await promisify(execFile)(
    registration.command,
    registration.args,
    { env: { ...env, ...registration.env } },
  );

  expect(stdout.trim()).toBe("new-build");
  expect(
    (await readCliInstallStamp(cliInstallStampPath(env)))?.mcpRegistrations,
  ).toHaveLength(2);
});

it("removes only the selected agent's entry and retains unrelated configuration", async () => {
  await install();
  const current = await config("claude");
  current.mcpServers.other = { command: "other" };
  await writeFile(path.join(homeDir, ".claude.json"), JSON.stringify(current));
  await removeCliInstall({ targets: ["claude"], homeDir, env });
  expect((await config("claude")).mcpServers).toEqual({
    other: { command: "other" },
  });
  expect((await config("codex")).mcp_servers).toHaveProperty("whiteboard");
  expect(
    (
      await readCliInstallStamp(cliInstallStampPath(env))
    )?.mcpRegistrations?.map((item) => item.target),
  ).toEqual(["codex"]);
  await removeCliInstall({ targets: ["codex"], homeDir, env });
  expect((await config("codex")).mcp_servers).toBeUndefined();
});

it("leaves a user's customized entry alone on update, reinstall, and uninstall", async () => {
  await install();
  const file = path.join(homeDir, ".codex/config.toml");

  const customized = (await readFile(file, "utf8")).replace(
    'args = [ "mcp" ]',
    'args = [ "custom" ]',
  );

  // Disable is a user choice even when the generated launch command is unchanged.
  const changed = customized.replace(
    "[mcp_servers.whiteboard]",
    "[mcp_servers.whiteboard]\nenabled = false",
  );

  await writeFile(file, changed);
  await install(true);
  await install();
  expect(await readFile(file, "utf8")).toBe(changed);
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.find(
      (item) => item.target === "codex",
    )?.state,
  ).toBe("custom");
  await removeCliInstall({ targets: ["codex"], homeDir, env });
  expect(await readFile(file, "utf8")).toBe(changed);
});

it("does not replace an existing foreign Review server or malformed settings", async () => {
  await mkdir(path.join(homeDir, ".codex"));
  const foreign = 'mcp_servers = { whiteboard = { command = "my-server" } }\n';
  await writeFile(path.join(homeDir, ".codex/config.toml"), foreign);
  await writeFile(path.join(homeDir, ".claude.json"), "{broken");
  expect((await install()).code).toBe(1);
  expect(await readFile(path.join(homeDir, ".codex/config.toml"), "utf8")).toBe(
    foreign,
  );
  expect(await readFile(path.join(homeDir, ".claude.json"), "utf8")).toBe(
    "{broken",
  );
});

it("does not reinstall a removed integration during a later automatic update", async () => {
  await install();
  await removeCliInstall({ targets: ["codex"], homeDir, env });
  await rm(path.join(homeDir, ".claude.json"));
  expect((await install(true)).code).toBe(0);
  expect((await config("codex")).mcp_servers).toBeUndefined();
  expect((await config("claude")).mcpServers).toHaveProperty("whiteboard");
});

for (const target of targets) {
  it(`migrates an unchanged legacy ${target} registration without touching other servers`, async () => {
    await install();
    const stamp = (await readCliInstallStamp(cliInstallStampPath(env)))!;
    const desired = reviewMcpRegistration(target, homeDir, env);
    await writeReviewMcpRegistration(desired, desired, true);

    const legacy = {
      ...desired,
      name: undefined,
      command: path.join(homeDir, "review-mcp"),
      env: { DEV_REVIEW_HOME: env.DEV_REVIEW_HOME! },
    };

    await writeReviewMcpRegistration(legacy);
    stamp.mcpRegistrations = stamp.mcpRegistrations!.map((item) =>
      item.target === target ? legacy : item,
    );
    await writeFile(cliInstallStampPath(env), JSON.stringify(stamp));
    expect((await install(true)).code).toBe(0);

    const servers = (await config(target))[
      target === "codex" ? "mcp_servers" : "mcpServers"
    ];

    expect(servers.review).toBeUndefined();
    expect(servers.whiteboard.command).toBe(desired.command);

    const { stdout } = await promisify(execFile)(
      servers.whiteboard.command,
      servers.whiteboard.args,
      { env: { ...env, ...servers.whiteboard.env } },
    );

    expect(JSON.parse(stdout).home).toBe(env.DEV_REVIEW_HOME);
  });

  it(`preserves a conflicting ${target} Whiteboard server during legacy migration`, async () => {
    const desired = reviewMcpRegistration(target, homeDir, env);
    const legacy = { ...desired, name: undefined };
    await writeReviewMcpRegistration(legacy);
    const foreign = { ...desired, command: "/custom/server" };
    await writeReviewMcpRegistration(foreign);
    const before = await readFile(desired.configPath, "utf8");
    expect(await writeReviewMcpRegistration(desired, legacy)).toBe(false);
    expect(await readFile(desired.configPath, "utf8")).toBe(before);
  });
}
