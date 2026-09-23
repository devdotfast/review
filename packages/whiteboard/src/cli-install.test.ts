import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  enableTraceRepository,
  installClaudeTraceHook,
  traceMachineStatus,
  traceRepositoryStatus,
  traceScope,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { type WhiteboardCliInstallStamp } from "@dev.fast/whiteboard-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCliInstall,
  cliInstallStampPath,
  cliInstallUpdateMarkerPath,
  ensureShellProfilePath,
  finishCliInstallUpdate,
  installWhiteboardCommand,
  pathShimPath,
  readCliInstallStamp,
  removeCliInstall,
  removeLegacyWhiteboardSkills,
  removeShellProfilePath,
  resetCliInstall,
  resolveCliInstallStatus,
  skipCliInstall,
  writePathShim,
} from "./cli-install";
import { whiteboardMcpLaunch } from "./connect-prompts";
import { cursorInstallDeeplink } from "./cursor-deeplink";

const temporaryDirectories: string[] = [];

const packageRoot = path.resolve(import.meta.dirname, "..");

const profileMarker =
  "# Managed by Whiteboard Desktop: whiteboard command PATH. Do not edit.";

const profileExport = 'export PATH="$HOME/.local/bin:$PATH"';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("skipCliInstall", () => {
  it("records skipped consent when no stamp exists", async () => {
    const env = await isolatedEnvironment();

    await skipCliInstall(env);

    expect(await readCliInstallStamp(cliInstallStampPath(env))).toMatchObject({
      consent: "skipped",
    });
    expect(existsSync(cliInstallUpdateMarkerPath(env))).toBe(true);

    await resetCliInstall(env);

    expect(existsSync(cliInstallStampPath(env))).toBe(false);
    expect(existsSync(cliInstallUpdateMarkerPath(env))).toBe(false);
  });

  it.each(["granted", "declined", "skipped"] as const)(
    "does not replace %s consent",
    async (consent) => {
      const env = await isolatedEnvironment();

      const stamp = {
        consent,
        updatedAt: "2026-08-09T00:00:00.000Z",
      } satisfies WhiteboardCliInstallStamp;

      await writePrivateJsonAtomic(cliInstallStampPath(env), stamp);

      await skipCliInstall(env);

      expect(await readCliInstallStamp(cliInstallStampPath(env))).toEqual(
        stamp,
      );
    },
  );
});

describe("trace capture installation", () => {
  it("recognizes an existing bucket install at its original paths without migration or login", async () => {
    const homeDir = await temporaryHome("whiteboard-legacy-trace-");
    const configDir = path.join(homeDir, ".config", "dev-trace");
    await mkdir(configDir, { recursive: true });

    const credentials =
      'TRACE_R2_ENDPOINT="https://storage.example.invalid"\nTRACE_R2_BUCKET="existing-traces"\nTRACE_R2_ACCESS_KEY_ID="fixture-key"\nTRACE_R2_SECRET_ACCESS_KEY="fixture-secret"\n';

    const settings = JSON.stringify({
      version: 1,
      enabled: true,
      autoActivateRepositories: true,
    });

    await writeFile(path.join(configDir, "env"), credentials, { mode: 0o600 });
    await writeFile(path.join(configDir, "settings.json"), settings);

    const status = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env: { DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev") },
    });

    expect(status.trace).toMatchObject({
      enabled: true,
      configured: true,
      bucket: "existing-traces",
      autoActivateRepositories: true,
    });
    expect(JSON.stringify(status)).not.toContain("fixture-secret");
    expect(await readFile(path.join(configDir, "env"), "utf8")).toBe(
      credentials,
    );
    expect(await readFile(path.join(configDir, "settings.json"), "utf8")).toBe(
      settings,
    );
  });

  it("writes a version-2 profile for a machine with no legacy files", async () => {
    const homeDir = await temporaryHome("whiteboard-fresh-trace-");

    const env: NodeJS.ProcessEnv = {
      DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
      TRACE_R2_MODE: "mock",
    };

    const applied = await applyCliInstall({
      packageRoot,
      homeDir,
      env,
      trace: {
        endpoint: "mock://endpoint",
        bucket: "fresh-bucket",
        key: "fresh-key-id",
        secret: "fresh-secret-value",
      },
    });

    expect(applied.code).toBe(0);
    const configPath = path.join(homeDir, ".dev", "trace", "config.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: 2,
      "current-store": "s3",
      stores: {
        s3: {
          bucket: "fresh-bucket",
          accessKeyId: "fresh-key-id",
          capture: { enabled: true, autoActivateRepositories: true },
        },
      },
    });
    expect(
      await readFile(path.join(homeDir, ".config", "dev-trace", "env"), "utf8")
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const status = await resolveCliInstallStatus({ packageRoot, homeDir, env });
    expect(status.trace).toMatchObject({
      enabled: true,
      configured: true,
      bucket: "fresh-bucket",
      credentialsSource: "profile",
      captureSource: "profile",
      storageMode: "s3",
    });
    expect(JSON.stringify(status)).not.toContain("fresh-secret-value");

    await removeCliInstall({ trace: true, homeDir, env });

    const disabled = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env,
    });

    expect(disabled.trace).toMatchObject({ enabled: false, configured: true });
    expect(
      JSON.parse(await readFile(configPath, "utf8")).stores.s3.secretAccessKey,
    ).toBe("fresh-secret-value");
  });

  it("uses the shared installer and keeps credentials when disabled", async () => {
    const homeDir = await mkdtemp(
      path.join(tmpdir(), "whiteboard-trace-install-"),
    );

    temporaryDirectories.push(homeDir);

    const env: NodeJS.ProcessEnv = {
      DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
      TRACE_ENV_FILE: path.join(homeDir, "trace.env"),
      TRACE_SETTINGS_FILE: path.join(homeDir, "trace-settings.json"),
      TRACE_R2_MODE: "mock",
    };

    const applied = await applyCliInstall({
      packageRoot,
      homeDir,
      env,
      trace: {
        endpoint: "mock://endpoint",
        bucket: "mock-bucket",
        key: "mock-key-id",
        secret: "mock-secret-value",
      },
    });

    expect(applied.code).toBe(0);
    const status = await resolveCliInstallStatus({ packageRoot, homeDir, env });
    expect(status.trace).toMatchObject({
      enabled: true,
      configured: true,
      autoActivateRepositories: true,
      accessKeyIdPrefix: "mock-k",
    });
    expect(JSON.stringify(status)).not.toContain("mock-secret-value");
    expect(status.stamp?.traceManaged).toBe(true);

    await removeCliInstall({ trace: true, homeDir, env });

    const disabled = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env,
    });

    expect(disabled.trace.enabled).toBe(false);
    expect(disabled.trace.configured).toBe(true);
    expect(await readFile(env.TRACE_ENV_FILE!, "utf8")).toContain(
      "mock-secret-value",
    );
  });
});

describe("shell profile PATH management", () => {
  it("adds the zsh profile block once", async () => {
    const homeDir = await temporaryHome("whiteboard-zsh-profile-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    await expect(ensureShellProfilePath({ homeDir, env })).resolves.toContain(
      ".zprofile",
    );
    const first = await readFile(path.join(homeDir, ".zprofile"), "utf8");
    expect(first).toBe(`\n${profileMarker}\n${profileExport}\n`);

    await expect(ensureShellProfilePath({ homeDir, env })).resolves.toBe("");
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toBe(first);
  });

  it("leaves an existing local bin profile entry unchanged", async () => {
    const homeDir = await temporaryHome("whiteboard-existing-profile-");
    const profilePath = path.join(homeDir, ".zprofile");
    const source = 'export PATH="$HOME/.local/bin:$PATH"\n# user content\n';
    await writeFile(profilePath, source);

    await expect(
      ensureShellProfilePath({
        homeDir,
        env: profileEnvironment(homeDir, "/bin/zsh"),
      }),
    ).resolves.toBe("");
    expect(await readFile(profilePath, "utf8")).toBe(source);
  });

  it("uses the bash profile", async () => {
    const homeDir = await temporaryHome("whiteboard-bash-profile-");

    await ensureShellProfilePath({
      homeDir,
      env: profileEnvironment(homeDir, "/bin/bash"),
    });

    expect(await readFile(path.join(homeDir, ".bash_profile"), "utf8")).toBe(
      `\n${profileMarker}\n${profileExport}\n`,
    );
  });

  it("warns without changing a fish profile", async () => {
    const homeDir = await temporaryHome("whiteboard-fish-profile-");

    await expect(
      ensureShellProfilePath({
        homeDir,
        env: profileEnvironment(homeDir, "/opt/homebrew/bin/fish"),
      }),
    ).resolves.toContain("fish_add_path ~/.local/bin");
    await expect(
      readFile(path.join(homeDir, ".zprofile"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(homeDir, ".bash_profile"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only exact managed blocks", async () => {
    const homeDir = await temporaryHome("whiteboard-remove-profile-");
    const zprofile = path.join(homeDir, ".zprofile");
    const bashProfile = path.join(homeDir, ".bash_profile");
    const userContent = "export EDITOR=vim\n";
    const markerFree = `# ${profileMarker}\n${profileExport}\n`;
    await Promise.all([
      writeFile(
        zprofile,
        `${userContent}\n${profileMarker}\n${profileExport}\n`,
      ),
      writeFile(bashProfile, markerFree),
    ]);

    await expect(removeShellProfilePath(homeDir)).resolves.toEqual([zprofile]);
    expect(await readFile(zprofile, "utf8")).toBe(userContent);
    expect(await readFile(bashProfile, "utf8")).toBe(markerFree);
  });
});

describe("whiteboard command installation", () => {
  it("preserves a command symlink and its target", async () => {
    const homeDir = await temporaryHome("whiteboard-cli-symlink-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "current-app", "whiteboard-cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "whiteboard");
    await Promise.all([
      mkdir(path.dirname(cliPath), { recursive: true }),
      mkdir(path.dirname(shimPath), { recursive: true }),
    ]);
    await writeFile(cliPath, "// current CLI\n");
    await writeFile(external(homeDir), "external\n", { mode: 0o755 });
    await symlink(external(homeDir), shimPath);

    const applied = await applyCliInstall({
      packageRoot,
      shim: true,
      cliPath,
      homeDir,
      env,
    });

    expect(applied).toMatchObject({ code: 0, shimPath });
    expect((await lstat(shimPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(shimPath, "utf8")).toBe("external\n");
    expect(await readFile(external(homeDir), "utf8")).toBe("external\n");
  });

  it("installs the command and profile and replaces a previous app shim", async () => {
    const homeDir = await temporaryHome("whiteboard-cli-only-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "current-app", "whiteboard-cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "whiteboard");
    await Promise.all([
      mkdir(path.dirname(cliPath), { recursive: true }),
      mkdir(path.dirname(shimPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(cliPath, "// current CLI\n"),
      writeFile(
        shimPath,
        "#!/bin/sh\n# Managed by Whiteboard Desktop\nFALLBACK_CLI='/Applications/Old Whiteboard.app/cli.js'\n",
        { mode: 0o755 },
      ),
    ]);

    const applied = await applyCliInstall({
      packageRoot,
      shim: true,
      cliPath,
      homeDir,
      env,
    });

    expect(applied).toMatchObject({ code: 0, shimPath });
    expect(applied.output).toContain("whiteboard command");
    const installed = await readFile(shimPath, "utf8");
    expect(installed).toContain(cliPath);
    expect(installed).not.toContain("Old Whiteboard.app");
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toContain(
      profileExport,
    );
    expect(await readCliInstallStamp(cliInstallStampPath(env))).toMatchObject({
      consent: "granted",
      shimPath,
    });
    expect(existsSync(cliInstallUpdateMarkerPath(env))).toBe(true);
    const status = await resolveCliInstallStatus({ packageRoot, homeDir, env });
    expect(status.shim).toMatchObject({
      installed: true,
      profileConfigured: true,
      onPath: false,
    });
  });

  it("treats an empty request as a no-op", async () => {
    const homeDir = await temporaryHome("whiteboard-empty-apply-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    expect(await applyCliInstall({ packageRoot, homeDir, env })).toEqual({
      code: 0,
      output: "",
    });
    expect(await readCliInstallStamp(cliInstallStampPath(env))).toBeNull();
  });

  it("keeps a removed command removed until it is installed explicitly", async () => {
    const homeDir = await temporaryHome("whiteboard-disabled-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const builtRoot = await builtPackageRoot();
    const cliPath = path.join(builtRoot, "dist", "whiteboard-cli.js");
    const shimPath = pathShimPath(homeDir);

    await applyCliInstall({
      packageRoot: builtRoot,
      shim: true,
      cliPath,
      homeDir,
      env,
    });
    await removeCliInstall({ shim: true, homeDir, env });
    expect(existsSync(shimPath)).toBe(false);

    await writeFile(
      path.join(builtRoot, "dist", "whiteboard-cli.js"),
      "// next build\n",
    );
    await applyCliInstall({
      packageRoot: builtRoot,
      autoUpdate: true,
      cliPath,
      homeDir,
      env,
    });
    expect(existsSync(shimPath)).toBe(false);

    await applyCliInstall({
      packageRoot: builtRoot,
      shim: true,
      cliPath,
      homeDir,
      env,
    });
    expect(existsSync(shimPath)).toBe(true);
  });

  it("fails when an explicit shim has no CLI", async () => {
    const homeDir = await temporaryHome("whiteboard-missing-explicit-cli-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    const applied = await applyCliInstall({
      packageRoot,
      shim: true,
      homeDir,
      env,
    });

    expect(applied.code).toBe(1);
    expect(applied.output).toContain("no built CLI");
  });

  it("warns when another whiteboard command comes first on PATH", async () => {
    const homeDir = await temporaryHome("whiteboard-shadowed-command-");
    const foreignBin = path.join(homeDir, "foreign-bin");
    const cliPath = path.join(homeDir, "cli.js");
    await mkdir(foreignBin, { recursive: true });
    await Promise.all([
      writeFile(cliPath, "// test CLI\n"),
      writeFile(path.join(foreignBin, "whiteboard"), "#!/bin/sh\n", {
        mode: 0o755,
      }),
    ]);

    const env = {
      ...profileEnvironment(homeDir, "/bin/zsh"),
      PATH: foreignBin,
    };

    const applied = await applyCliInstall({
      packageRoot,
      shim: true,
      cliPath,
      homeDir,
      env,
    });

    expect(applied.output).toContain(path.join(foreignBin, "whiteboard"));
    expect(applied.output).toContain(
      "docs/troubleshooting.md#the-command-opens-a-browser-or-shows-old-options",
    );
  });

  it("removes the owned command and profile block", async () => {
    const homeDir = await temporaryHome("whiteboard-remove-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "cli.js");
    await writeFile(cliPath, "// test CLI\n");
    await applyCliInstall({ packageRoot, shim: true, cliPath, homeDir, env });

    const removed = await removeCliInstall({ shim: true, homeDir, env });

    expect(removed.output).toContain("removed Whiteboard PATH entry");
    await expect(
      readFile(path.join(homeDir, ".local", "bin", "whiteboard"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toBe("");
  });

  it("preserves a foreign command while removing the managed profile block", async () => {
    const homeDir = await temporaryHome("whiteboard-foreign-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const shimPath = path.join(homeDir, ".local", "bin", "whiteboard");
    await mkdir(path.dirname(shimPath), { recursive: true });
    await writeFile(shimPath, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    await ensureShellProfilePath({ homeDir, env });

    const removed = await removeCliInstall({ shim: true, homeDir, env });

    expect(removed.output).toContain("left in place");
    expect(await readFile(shimPath, "utf8")).toContain("echo foreign");
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toBe("");
  });
});

function external(homeDir: string): string {
  return path.join(homeDir, "external-command");
}

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "whiteboard-cli-install-"),
  );

  temporaryDirectories.push(directory);

  return { DEV_WHITEBOARD_HOME: directory };
}

async function temporaryHome(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);

  return directory;
}

function profileEnvironment(homeDir: string, shell: string): NodeJS.ProcessEnv {
  return {
    DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
    PATH: "/usr/bin:/bin",
    SHELL: shell,
  };
}

describe("installed launcher runtime selection", () => {
  it("refreshes a managed launcher to the selected build and profile even when the old build exists", async () => {
    const homeDir = await temporaryHome("whiteboard-refresh-shim-");
    const oldCli = path.join(homeDir, "old.cjs");
    const cliPath = path.join(homeDir, "current.cjs");
    await writeFile(oldCli, 'console.log("old-build")');
    await writeFile(
      cliPath,
      'console.log(JSON.stringify({build:"current",home:process.env.DEV_WHITEBOARD_HOME}))',
    );
    const shim = path.join(homeDir, ".local", "bin", "whiteboard");
    await writePathShim(
      shim,
      oldCli,
      process.execPath,
      path.join(homeDir, "old-profile"),
    );
    const env = profileEnvironment(homeDir, "/bin/zsh");
    await installWhiteboardCommand({
      homeDir,
      env,
      cliPath,
      cliRuntimePath: process.execPath,
    });

    const { stdout } = await promisify(execFile)(shim, [], {
      env: { PATH: "/usr/bin:/bin", DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE: "1" },
    });

    expect(JSON.parse(stdout)).toEqual({
      build: "current",
      home: env.DEV_WHITEBOARD_HOME,
    });
  });

  it("retains the installed profile when invoked without the setup environment", async () => {
    const home = await temporaryHome("whiteboard-profile-shim-");
    const profile = path.join(home, "a profile");
    const cli = path.join(home, "cli.cjs");
    const shim = path.join(home, "whiteboard");
    await writeFile(cli, "console.log(process.env.DEV_WHITEBOARD_HOME)");
    await writePathShim(shim, cli, process.execPath, profile);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.DEV_WHITEBOARD_HOME;

    const result = await promisify(execFile)(shim, ["trace", "status"], {
      env,
    });

    expect(result.stdout.trim()).toBe(profile);
  });

  it.each([
    ["healthy discovery", true, true, false, "discovered"],
    ["missing discovered CLI", false, true, false, "fallback"],
    ["missing discovered runtime", true, false, false, "fallback"],
    ["delegation disabled", true, true, true, "fallback"],
  ] as const)(
    "runs a matched CLI and runtime with %s",
    async (_name, cliExists, runtimeExists, noDelegate, expected) => {
      const home = await temporaryHome("whiteboard-shim-routing-");
      const shim = path.join(home, "whiteboard");
      const fallbackCli = path.join(home, "fallback-cli.js");
      const fallbackRuntime = path.join(home, "fallback-runtime");
      const discoveredCli = path.join(home, "discovered-cli.js");
      const discoveredRuntime = path.join(home, "discovered-runtime");
      await writeFile(fallbackCli, "// CLI fixture\n");
      await writeFile(
        fallbackRuntime,
        '#!/bin/sh\nprintf "%s\\n" "fallback" "guard=$DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE" "delegated=$DEV_FAST_WHITEBOARD_CLI_DELEGATED" "$@"\n',
        { mode: 0o755 },
      );

      if (cliExists) await writeFile(discoveredCli, "// CLI fixture\n");

      if (runtimeExists)
        await writeFile(
          discoveredRuntime,
          '#!/bin/sh\nprintf "%s\\n" "discovered" "guard=$DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE" "delegated=$DEV_FAST_WHITEBOARD_CLI_DELEGATED" "$@"\n',
          { mode: 0o755 },
        );
      const discoveryDir = path.join(home, "review-desktop");
      await mkdir(discoveryDir);
      await writeFile(
        path.join(discoveryDir, "server.json"),
        JSON.stringify({
          cliPath: discoveredCli,
          cliRuntimePath: discoveredRuntime,
        }),
      );
      await writePathShim(shim, fallbackCli, fallbackRuntime, home);

      const { stdout } = await promisify(execFile)(shim, ["trace", "status"], {
        env: {
          ...process.env,
          DEV_WHITEBOARD_HOME: home,
          DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE: noDelegate ? "1" : "",
        },
      });

      expect(stdout.trim().split("\n")).toEqual([
        expected,
        "guard=1",
        `delegated=${expected === "discovered" ? "1" : ""}`,
        expected === "fallback" ? fallbackCli : discoveredCli,
        "trace",
        "status",
      ]);
    },
  );
});

describe("Desktop installation alongside npm", () => {
  it("preserves the npm launcher and its target when npm uses ~/.local/bin", async () => {
    const homeDir = await temporaryHome("whiteboard-npm-coexist-");
    const cli = path.join(homeDir, "npm/cli.js");
    const shim = path.join(homeDir, ".local/bin/whiteboard");
    await mkdir(path.dirname(cli), { recursive: true });
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(cli, "#!/usr/bin/env node\n// npm-owned\n", {
      mode: 0o755,
    });
    await symlink(cli, shim);
    const before = await readFile(cli, "utf8");

    const result = await installWhiteboardCommand({
      homeDir,
      cliPath: path.join(packageRoot, "dist/whiteboard-cli.js"),
      env: { PATH: "" },
    });

    expect(result.output).toContain("kept");
    expect((await lstat(shim)).isSymbolicLink()).toBe(true);
    expect(await readFile(cli, "utf8")).toBe(before);
  });
});

it("Desktop removal preserves hooks and capture owned by an npm installation", async () => {
  const homeDir = await temporaryHome("whiteboard-uninstall-coexist-");

  const env = {
    DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
    TRACE_R2_MODE: "mock",
  };

  const npm = path.join(homeDir, "npm/bin/whiteboard");
  await mkdir(path.dirname(npm), { recursive: true });
  await writeFile(npm, "#!/bin/sh\n", { mode: 0o755 });

  const installed = await applyCliInstall({
    packageRoot,
    homeDir,
    env,
    trace: {
      endpoint: "mock://endpoint",
      bucket: "fixture",
      key: "key",
      secret: "secret",
    },
  });

  expect(installed.code).toBe(0);
  const hook = await installClaudeTraceHook(homeDir, npm);
  const before = await readFile(hook.path, "utf8");
  await applyCliInstall({
    packageRoot,
    shim: true,
    trace: true,
    cliPath: path.join(packageRoot, "dist/whiteboard-cli.js"),
    homeDir,
    env,
  });
  expect(await readFile(hook.path, "utf8")).toBe(before);
  await removeCliInstall({
    shim: true,
    trace: true,
    homeDir,
    env,
  });
  expect(await readFile(hook.path, "utf8")).toBe(before);
  expect((await traceMachineStatus({ homeDir, env })).enabled).toBe(true);
});

const STAMPED_SKILL = `---
name: dev-review
description: x
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit."
  review-version: "1.2.3"
---
# body
`;

async function builtPackageRoot(): Promise<string> {
  const root = await temporaryHome("whiteboard-built-package-");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"version":"1.2.3"}\n');
  await writeFile(
    path.join(root, "dist", "whiteboard-cli.js"),
    "// built CLI\n",
  );

  return root;
}

describe("MCP self-install", () => {
  const now = "2026-09-01T00:00:00.000Z";
  let homeDir: string;
  let env: NodeJS.ProcessEnv;
  let builtRoot: string;
  let cliPath: string;
  let shim: string;

  beforeEach(async () => {
    homeDir = await temporaryHome("whiteboard-self-install-");
    env = profileEnvironment(homeDir, "/bin/zsh");
    builtRoot = await builtPackageRoot();
    cliPath = path.join(builtRoot, "dist", "whiteboard-cli.js");
    shim = pathShimPath(homeDir);
  });

  const writeStamp = (
    stamp: WhiteboardCliInstallStamp & { targets?: string[] },
  ) => writePrivateJsonAtomic(cliInstallStampPath(env), stamp);

  const writeStampedSkill = async (skillDir: string) => {
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), STAMPED_SKILL);
  };

  describe("install status", () => {
    it("reports updateNeeded for a granted stamp without the update marker and none of its old fields", async () => {
      await writeStamp({
        consent: "granted",
        fingerprint: "old",
        targets: ["claude"],
        shimPath: shim,
        updatedAt: now,
      });

      const status = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      expect(status.updateNeeded).toBe(true);
      expect(Object.keys(status)).not.toContain("agents");
      expect(Object.keys(status.stamp ?? {})).not.toContain("targets");
    });

    it("reports updateNeeded for a pre-per-target stamp", async () => {
      await writeStamp({
        consent: "granted",
        fingerprint: "old",
        updatedAt: now,
      });

      expect(
        (
          await resolveCliInstallStatus({
            packageRoot: builtRoot,
            homeDir,
            env,
          })
        ).updateNeeded,
      ).toBe(true);
    });

    it("generates prompts with the sh launch form when the shim exists and the bare command otherwise", async () => {
      await writePathShim(shim, cliPath, undefined, path.join(homeDir, ".dev"));

      const built = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      expect(built.connect).toMatchObject({
        command: "sh",
        args: ["-c", 'exec "$HOME/.local/bin/whiteboard" mcp'],
      });
      expect(built.connect.prompts.claude).toContain(
        "$HOME/.local/bin/whiteboard",
      );

      await rm(shim);

      const source = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      expect(source.connect).toMatchObject({
        command: "whiteboard",
        args: ["mcp"],
      });
      expect(source.connect.prompts.pi).toContain(
        "whiteboard api session_get_instructions",
      );
    });

    it("offers each harness's plugin, with the Cursor link only when the shim exists", async () => {
      await writePathShim(shim, cliPath, undefined, path.join(homeDir, ".dev"));

      const built = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      const { plugins } = built.connect;

      const readme = (harness: string) =>
        readFile(
          path.join(packageRoot, "..", "agent-plugins", harness, "README.md"),
          "utf8",
        );

      for (const harness of ["claude", "codex", "pi"] as const) {
        const text = await readme(harness);

        expect(plugins[harness].command).toBeTruthy();

        for (const line of (plugins[harness].command ?? "").split("\n")) {
          expect(text).toContain(line);
        }
      }

      expect(plugins.opencode.command).toContain(
        "@dev.fast/opencode-whiteboard",
      );
      expect(await readme("opencode")).toContain(
        "@dev.fast/opencode-whiteboard",
      );
      expect(plugins.cursor).toEqual({
        label: "Install in Cursor",
        url: cursorInstallDeeplink(whiteboardMcpLaunch(true)),
      });

      await rm(shim);

      const withoutShim = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      expect(withoutShim.connect.plugins.cursor).toEqual({
        label: "Install in Cursor",
      });
    });

    it("lists Whiteboard-stamped legacy skills", async () => {
      await writeStampedSkill(
        path.join(homeDir, ".claude", "skills", "dev-review"),
      );

      const status = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      expect(status.legacySkills).toEqual([
        { path: path.join(homeDir, ".claude", "skills", "dev-review") },
      ]);
    });
  });

  describe("finishCliInstallUpdate", () => {
    it("writes the update marker and leaves a legacy stamp as it was", async () => {
      await writeStamp({
        consent: "granted",
        fingerprint: "old",
        targets: ["claude"],
        shimPath: shim,
        commandDisabled: true,
        traceManaged: true,
        updatedAt: now,
      });

      const before = await readFile(cliInstallStampPath(env), "utf8");

      await finishCliInstallUpdate(env);

      expect(await readFile(cliInstallStampPath(env), "utf8")).toBe(before);
      expect(existsSync(cliInstallUpdateMarkerPath(env))).toBe(true);
      expect(
        (
          await resolveCliInstallStatus({
            packageRoot: builtRoot,
            homeDir,
            env,
          })
        ).updateNeeded,
      ).toBe(false);
    });
  });

  describe("autoUpdate resync", () => {
    it("rewrites only the shim and never touches agent files", async () => {
      await writeStamp({
        consent: "granted",
        fingerprint: "old",
        shimPath: shim,
        updatedAt: now,
      });
      const claudeConfig = path.join(homeDir, ".claude.json");
      await writeFile(claudeConfig, "{}");

      const result = await applyCliInstall({
        packageRoot: builtRoot,
        homeDir,
        env,
        autoUpdate: true,
        cliPath,
      });

      expect(result.code).toBe(0);
      expect(await readFile(shim, "utf8")).toContain("Managed by Whiteboard");
      expect(await readFile(claudeConfig, "utf8")).toBe("{}");
      expect(
        (await readCliInstallStamp(cliInstallStampPath(env)))?.fingerprint,
      ).not.toBe("old");
    });

    it("keeps updateNeeded across a resync for an upgrader", async () => {
      await writeStamp({
        consent: "granted",
        fingerprint: "old",
        shimPath: shim,
        updatedAt: now,
      });

      const result = await applyCliInstall({
        packageRoot: builtRoot,
        homeDir,
        env,
        autoUpdate: true,
        cliPath,
      });

      expect(result.code).toBe(0);
      expect(
        (await readCliInstallStamp(cliInstallStampPath(env)))?.fingerprint,
      ).not.toBe("old");
      expect(
        (
          await resolveCliInstallStatus({
            packageRoot: builtRoot,
            homeDir,
            env,
          })
        ).updateNeeded,
      ).toBe(true);
    });
  });

  describe("removeLegacyWhiteboardSkills", () => {
    it("removes stamped skills and the status no longer lists them", async () => {
      await writeStampedSkill(
        path.join(homeDir, ".agents", "skills", "scratchpad"),
      );

      const { removed } = await removeLegacyWhiteboardSkills({ homeDir, env });

      expect(removed).toHaveLength(1);
      expect(
        (
          await resolveCliInstallStatus({
            packageRoot: builtRoot,
            homeDir,
            env,
          })
        ).legacySkills,
      ).toEqual([]);
    });
  });
});

it("upgrades enabled repository hooks during a command-only install", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "whiteboard-shim-trace-"));
  temporaryDirectories.push(homeDir);
  const cwd = path.join(homeDir, "repo");
  await mkdir(cwd);
  const run = promisify(execFile);
  await run("git", ["init", "--quiet", cwd]);
  const settings = path.join(homeDir, "trace-settings.json");
  await writeFile(
    settings,
    JSON.stringify({
      version: 1,
      enabled: true,
      autoActivateRepositories: true,
    }),
  );

  const env = {
    ...process.env,
    DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
    TRACE_SETTINGS_FILE: settings,
    DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE: "1",
  };

  const oldCommand = path.join(homeDir, ".local", "bin", "review");
  await mkdir(path.dirname(oldCommand), { recursive: true });
  await writeFile(
    oldCommand,
    "#!/bin/sh\n# Managed by Review Desktop\nexit 1\n",
  );
  await enableTraceRepository({
    cwd,
    scope: traceScope({ homeDir, env }),
    whiteboardCommand: oldCommand,
  });
  const cliPath = path.join(homeDir, "whiteboard-cli.js");
  const invoked = path.join(homeDir, "invoked.json");
  await writeFile(
    cliPath,
    `require("node:fs").writeFileSync(${JSON.stringify(invoked)}, JSON.stringify(process.argv.slice(2)));`,
  );

  const result = await applyCliInstall({
    shim: true,
    homeDir,
    env,
    packageRoot,
    cliPath,
    cliRuntimePath: process.execPath,
  });

  expect(result.code).toBe(0);
  await expect(lstat(oldCommand)).rejects.toThrow(/ENOENT/);
  const hooks = await traceRepositoryStatus(cwd);
  await run(
    "sh",
    [path.join(hooks.managedHooksPath!, "prepare-commit-msg"), "message"],
    { cwd, env },
  );
  expect(JSON.parse(await readFile(invoked, "utf8"))).toEqual([
    "trace",
    "git-hook",
    "prepare-commit-msg",
    "message",
  ]);
});
