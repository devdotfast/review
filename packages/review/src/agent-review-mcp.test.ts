import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parse as parseJsonc } from "jsonc-parser";
import { parse } from "smol-toml";
import { afterEach, beforeEach, expect, it } from "vitest";

import { reviewMcpLauncher, reviewMcpRegistration } from "./agent-review-mcp";
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
  const file = (await reviewMcpRegistration(target, homeDir, env)).configPath;
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
  const registration = (await config("claude")).mcpServers.review;

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
  ).toEqual(["ready", "ready", "missing", "missing"]);
});

it("repairs missing registrations and launcher automatically for a previously enabled install", async () => {
  await install();
  await rm(path.join(homeDir, ".codex/config.toml"));
  await rm(reviewMcpLauncher(env));
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).stale,
  ).toBe(true);
  expect((await install(true)).code).toBe(0);
  expect((await config("codex")).mcp_servers).toHaveProperty("review");
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
  const registration = (await config("claude")).mcpServers.review;

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
  expect((await config("codex")).mcp_servers).toHaveProperty("review");
  expect(
    (
      await readCliInstallStamp(cliInstallStampPath(env))
    )?.mcpRegistrations?.map((item) => item.target),
  ).toEqual(["codex"]);
  await removeCliInstall({ targets: ["codex"], homeDir, env });
  expect((await config("codex")).mcp_servers).toBeUndefined();
});

it("replaces a Codex review entry Review did not write", async () => {
  await mkdir(path.join(homeDir, ".codex"));
  const file = path.join(homeDir, ".codex/config.toml");

  await writeFile(
    file,
    'model = "gpt-5"\n\n[mcp_servers.review]\ncommand = "review"\nargs = ["mcp"]\n\n[mcp_servers.review.env]\nFOO = "1"\n\n[mcp_servers.other]\ncommand = "other"\n',
  );
  await install();

  const config = parse(await readFile(file, "utf8"));

  expect(config.model).toBe("gpt-5");
  expect(config.mcp_servers).toMatchObject({
    other: { command: "other" },
    review: { args: ["mcp"] },
  });
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.find(
      (item) => item.target === "codex",
    )?.state,
  ).toBe("ready");
});

it("leaves a Codex review entry the user disabled", async () => {
  await install();
  const file = path.join(homeDir, ".codex/config.toml");

  const disabled = (await readFile(file, "utf8")).replace(
    "[mcp_servers.review]",
    "[mcp_servers.review]\nenabled = false",
  );

  await writeFile(file, disabled);
  await install(true);
  await install();
  expect(await readFile(file, "utf8")).toBe(disabled);
  expect(
    (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.find(
      (item) => item.target === "codex",
    )?.state,
  ).toBe("custom");
  await removeCliInstall({ targets: ["codex"], homeDir, env });
  expect(await readFile(file, "utf8")).toBe(disabled);
});

it("does not replace an existing foreign Review server or malformed settings", async () => {
  await mkdir(path.join(homeDir, ".codex"));
  const foreign = 'mcp_servers = { review = { command = "my-server" } }\n';
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
  expect((await config("claude")).mcpServers).toHaveProperty("review");
});

it.each(["cursor", "opencode"] as const)(
  "registers, repairs, and removes %s through app setup",
  async (target) => {
    const registration = await reviewMcpRegistration(target, homeDir, env);
    const key = target === "opencode" ? "mcp" : "mcpServers";

    const original = `{
  // Keep this preference and other server.
  "theme": "dark",
  "${key}": { "other": { "command": "other" }, },
}\n`;

    await mkdir(path.dirname(registration.configPath), { recursive: true });
    await writeFile(registration.configPath, original);

    const apply = (autoUpdate = false) =>
      applyCliInstall({
        packageRoot,
        targets: [target],
        homeDir,
        env,
        cliPath,
        cliRuntimePath: process.execPath,
        autoUpdate,
      });

    expect((await apply()).code).toBe(0);
    const source = await readFile(registration.configPath, "utf8");
    expect(source).toContain("// Keep this preference and other server.");
    const settings = parseJsonc(source);
    expect(settings.theme).toBe("dark");
    expect(settings[key].other).toEqual({ command: "other" });
    const server = settings[key].review;
    const command = target === "opencode" ? server.command[0] : server.command;
    const args = target === "opencode" ? server.command.slice(1) : server.args;
    const environment = target === "opencode" ? server.environment : server.env;
    expect(server.type).toBe(target === "opencode" ? "local" : "stdio");

    const { stdout } = await promisify(execFile)(command, args, {
      env: { ...env, DEV_REVIEW_SERVER_DIR: "other-server", ...environment },
    });

    expect(JSON.parse(stdout)).toEqual({
      args: ["mcp"],
      home: env.DEV_REVIEW_HOME,
      serverDir: "",
      build: 1,
    });
    expect(
      (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.find(
        (item) => item.target === target,
      )?.state,
    ).toBe("ready");
    await apply();
    expect(await readFile(registration.configPath, "utf8")).toBe(source);

    await rm(registration.configPath);
    expect(
      (await resolveCliInstallStatus({ packageRoot, homeDir, env })).stale,
    ).toBe(true);
    expect((await apply(true)).code).toBe(0);
    expect(
      parseJsonc(await readFile(registration.configPath, "utf8"))[key].review,
    ).toEqual(server);

    await writeFile(registration.configPath, source);
    await removeCliInstall({ targets: [target], homeDir, env });
    const removed = await readFile(registration.configPath, "utf8");
    expect(removed).toContain("// Keep this preference and other server.");
    expect(parseJsonc(removed)[key]).toEqual({ other: { command: "other" } });
    await apply(true);
    expect(await readFile(registration.configPath, "utf8")).toBe(removed);
  },
);

it.each(["cursor", "opencode"] as const)(
  "preserves customized and malformed %s settings",
  async (target) => {
    const registration = await reviewMcpRegistration(target, homeDir, env);
    const key = target === "opencode" ? "mcp" : "mcpServers";

    const apply = () =>
      applyCliInstall({
        packageRoot,
        targets: [target],
        homeDir,
        env,
        cliPath,
        cliRuntimePath: process.execPath,
      });

    await apply();

    const settings = parseJsonc(
      await readFile(registration.configPath, "utf8"),
    );

    settings[key].review.enabled = false;
    const custom = JSON.stringify(settings);
    await writeFile(registration.configPath, custom);
    await apply();
    expect(
      (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.find(
        (item) => item.target === target,
      )?.state,
    ).toBe("custom");
    await removeCliInstall({ targets: [target], homeDir, env });
    expect(await readFile(registration.configPath, "utf8")).toBe(custom);
    await writeFile(registration.configPath, "{broken");
    expect((await apply()).code).toBe(1);
    expect(await readFile(registration.configPath, "utf8")).toBe("{broken");
    expect(
      (await resolveCliInstallStatus({ packageRoot, homeDir, env })).mcp?.find(
        (item) => item.target === target,
      )?.state,
    ).toBe("error");
  },
);

it("keeps OpenCode ownership when a JSONC config is added later", async () => {
  const apply = () =>
    applyCliInstall({
      packageRoot,
      targets: ["opencode"],
      homeDir,
      env,
      cliPath,
      cliRuntimePath: process.execPath,
    });

  await apply();
  const registration = await reviewMcpRegistration("opencode", homeDir, env);

  const jsonc = path.join(
    path.dirname(registration.configPath),
    "opencode.jsonc",
  );

  const preferences = '{ "model": "provider/model" }';
  await writeFile(jsonc, preferences);
  await apply();
  expect(await readFile(jsonc, "utf8")).toBe(preferences);
  await removeCliInstall({ targets: ["opencode"], homeDir, env });
  expect(
    parseJsonc(await readFile(registration.configPath, "utf8")).mcp.review,
  ).toBeUndefined();
});

it("uses OpenCode's existing JSONC config under XDG_CONFIG_HOME", async () => {
  env.XDG_CONFIG_HOME = path.join(homeDir, "xdg");
  const file = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{\n // My model\n "model": "provider/model",\n}\n');
  expect(
    (
      await applyCliInstall({
        packageRoot,
        targets: ["opencode"],
        homeDir,
        env,
        cliPath,
        cliRuntimePath: process.execPath,
      })
    ).code,
  ).toBe(0);
  const source = await readFile(file, "utf8");
  expect(source).toContain("// My model");
  expect(parseJsonc(source).mcp.review.command).toEqual([
    reviewMcpLauncher(env),
    "mcp",
  ]);
  await expect(
    readFile(path.join(path.dirname(file), "opencode.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (
      await readCliInstallStamp(cliInstallStampPath(env))
    )?.mcpRegistrations?.find((item) => item.target === "opencode")?.configPath,
  ).toBe(file);
  await removeCliInstall({ targets: ["opencode"], homeDir, env });
  expect(parseJsonc(await readFile(file, "utf8")).mcp.review).toBeUndefined();
});
