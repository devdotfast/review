import { execFile } from "node:child_process";
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
import type { WhiteboardCliInstallStamp } from "@dev.fast/whiteboard-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCliInstall,
  cliInstallStampPath,
  ensureShellProfilePath,
  installWhiteboardCommand,
  readCliInstallStamp,
  removeCliInstall,
  removeShellProfilePath,
  resolveCliInstallStatus,
  resolveInstalledWhiteboardAgentStatus,
  skipCliInstall,
  writePathShim,
} from "./cli-install";

const temporaryDirectories: string[] = [];

const packageRoot = path.resolve(import.meta.dirname, "..");

const profileMarker =
  "# Managed by Whiteboard: whiteboard command PATH. Do not edit.";

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
    const homeDir = await temporaryHome("review-legacy-trace-");
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
    const homeDir = await temporaryHome("review-fresh-trace-");

    const env: NodeJS.ProcessEnv = {
      DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
      TRACE_R2_MODE: "mock",
    };

    const applied = await applyCliInstall({
      packageRoot,
      targets: [],
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

    await removeCliInstall({ targets: [], trace: true, homeDir, env });

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
    const homeDir = await mkdtemp(path.join(tmpdir(), "review-trace-install-"));
    temporaryDirectories.push(homeDir);

    const env: NodeJS.ProcessEnv = {
      DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
      TRACE_ENV_FILE: path.join(homeDir, "trace.env"),
      TRACE_SETTINGS_FILE: path.join(homeDir, "trace-settings.json"),
      TRACE_R2_MODE: "mock",
    };

    const applied = await applyCliInstall({
      packageRoot,
      targets: [],
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

    await removeCliInstall({ targets: [], trace: true, homeDir, env });

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
    const homeDir = await temporaryHome("review-zsh-profile-");
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
    const homeDir = await temporaryHome("review-existing-profile-");
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
    const homeDir = await temporaryHome("review-bash-profile-");

    await ensureShellProfilePath({
      homeDir,
      env: profileEnvironment(homeDir, "/bin/bash"),
    });

    expect(await readFile(path.join(homeDir, ".bash_profile"), "utf8")).toBe(
      `\n${profileMarker}\n${profileExport}\n`,
    );
  });

  it("warns without changing a fish profile", async () => {
    const homeDir = await temporaryHome("review-fish-profile-");

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
    const homeDir = await temporaryHome("review-remove-profile-");
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

describe("skill and review command installation", () => {
  it("preserves a command symlink and its target", async () => {
    const homeDir = await temporaryHome("review-cli-symlink-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "current-app", "whiteboard-cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "whiteboard");
    const external = path.join(homeDir, "external-command");
    await Promise.all([
      mkdir(path.dirname(cliPath), { recursive: true }),
      mkdir(path.dirname(shimPath), { recursive: true }),
    ]);
    await writeFile(cliPath, "// current CLI\n");
    await writeFile(external, "external\n", { mode: 0o755 });
    await symlink(external, shimPath);

    const applied = await applyCliInstall({
      packageRoot,
      targets: [],
      shim: true,
      cliPath,
      homeDir,
      env,
    });

    expect(applied).toMatchObject({ code: 0, shimPath });
    expect((await lstat(shimPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(shimPath, "utf8")).toBe("external\n");
    expect(await readFile(external, "utf8")).toBe("external\n");
  });

  it("installs only the command and replaces a previous app shim", async () => {
    const homeDir = await temporaryHome("review-cli-only-shim-");
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
        "#!/bin/sh\n# Managed by Review Desktop\nFALLBACK_CLI='/Applications/Old Review.app/cli.js'\n",
        { mode: 0o755 },
      ),
    ]);

    const applied = await applyCliInstall({
      packageRoot,
      targets: [],
      shim: true,
      cliPath,
      homeDir,
      env,
    });

    expect(applied).toMatchObject({ code: 0, shimPath });
    const installed = await readFile(shimPath, "utf8");
    expect(installed).toContain(cliPath);
    expect(installed).not.toContain("Old Review.app");
    expect(await readCliInstallStamp(cliInstallStampPath(env))).toMatchObject({
      consent: "granted",
      targets: [],
      shimPath,
    });
  });

  it("installs the command and profile by default for a skill target", async () => {
    const homeDir = await temporaryHome("review-default-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "whiteboard-cli.js");
    await writeFile(cliPath, "// test CLI\n");

    const applied = await applyCliInstall({
      packageRoot,
      targets: ["codex"],
      cliPath,
      homeDir,
      env,
    });

    expect(applied).toMatchObject({
      code: 0,
      shimPath: path.join(homeDir, ".local", "bin", "whiteboard"),
    });
    expect(await readFile(applied.shimPath!, "utf8")).toContain(
      "Managed by Whiteboard",
    );
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toContain(
      profileExport,
    );
    expect(
      await readFile(
        path.join(homeDir, ".agents", "skills", "dev-review", "SKILL.md"),
        "utf8",
      ),
    ).toContain("name: dev-review");
    await rm(cliInstallStampPath(env), { force: true });
    const status = await resolveCliInstallStatus({ packageRoot, homeDir, env });
    expect(status.shim).toMatchObject({
      installed: true,
      profileConfigured: true,
      onPath: false,
    });
  });

  it("supports an explicit shim opt-out", async () => {
    const homeDir = await temporaryHome("review-no-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    const applied = await applyCliInstall({
      packageRoot,
      targets: ["codex"],
      shim: false,
      homeDir,
      env,
    });

    expect(applied.code).toBe(0);
    await expect(
      readFile(path.join(homeDir, ".local", "bin", "whiteboard"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(homeDir, ".zprofile"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warns when the default shim has no CLI", async () => {
    const homeDir = await temporaryHome("review-missing-default-cli-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    const applied = await applyCliInstall({
      packageRoot,
      targets: ["codex"],
      homeDir,
      env,
    });

    expect(applied.code).toBe(0);
    expect(applied.output).toContain("The skills were installed");
  });

  it("fails when an explicit shim has no CLI", async () => {
    const homeDir = await temporaryHome("review-missing-explicit-cli-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    const applied = await applyCliInstall({
      packageRoot,
      targets: ["codex"],
      shim: true,
      homeDir,
      env,
    });

    expect(applied.code).toBe(1);
    expect(applied.output).toContain("no built CLI");
  });

  it("warns when another review command comes first on PATH", async () => {
    const homeDir = await temporaryHome("review-shadowed-command-");
    const foreignBin = path.join(homeDir, "foreign-bin");
    const cliPath = path.join(homeDir, "whiteboard-cli.js");
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
      targets: ["codex"],
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
    const homeDir = await temporaryHome("review-remove-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "whiteboard-cli.js");
    await writeFile(cliPath, "// test CLI\n");
    await applyCliInstall({
      packageRoot,
      targets: ["codex"],
      cliPath,
      homeDir,
      env,
    });

    const removed = await removeCliInstall({
      targets: [],
      shim: true,
      homeDir,
      env,
    });

    expect(removed.output).toContain("removed Review PATH entry");
    await expect(
      readFile(path.join(homeDir, ".local", "bin", "whiteboard"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toBe("");
  });

  it("preserves a foreign command while removing the managed profile block", async () => {
    const homeDir = await temporaryHome("review-foreign-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const shimPath = path.join(homeDir, ".local", "bin", "whiteboard");
    await mkdir(path.dirname(shimPath), { recursive: true });
    await writeFile(shimPath, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
    await ensureShellProfilePath({ homeDir, env });

    const removed = await removeCliInstall({
      targets: [],
      shim: true,
      homeDir,
      env,
    });

    expect(removed.output).toContain("left in place");
    expect(await readFile(shimPath, "utf8")).toContain("echo foreign");
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toBe("");
  });
});

describe("resolveInstalledWhiteboardAgentStatus", () => {
  it("detects installed agents without invoking their CLIs", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "review-agent-status-"));
    temporaryDirectories.push(homeDir);
    const binDir = path.join(homeDir, "bin");
    const probeLog = path.join(homeDir, "agent-probes.log");
    await Promise.all([
      mkdir(binDir, { recursive: true }),
      mkdir(path.join(homeDir, ".claude", "skills", "dev-review"), {
        recursive: true,
      }),
    ]);
    await writeFile(
      path.join(homeDir, ".claude", "skills", "dev-review", "SKILL.md"),
      "---\nname: dev-review\n---\n",
    );
    const executable = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "$AGENT_PROBE_LOG"\nexit 1\n`;
    await Promise.all(
      ["claude", "codex"].map((name) =>
        writeFile(path.join(binDir, name), executable, { mode: 0o755 }),
      ),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_PROBE_LOG: probeLog,
      DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
      PATH: binDir,
    };

    const status = await resolveInstalledWhiteboardAgentStatus({
      homeDir,
      env,
    });

    expect(status.agents).toContainEqual({
      target: "claude",
      present: true,
      installed: true,
    });
    await expect(readFile(probeLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-cli-install-"));
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
    const homeDir = await temporaryHome("review-refresh-shim-");
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
    const home = await temporaryHome("review-profile-shim-");
    const profile = path.join(home, "a profile");
    const cli = path.join(home, "cli.cjs");
    const shim = path.join(home, "review");
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
      const home = await temporaryHome("review-shim-routing-");
      const shim = path.join(home, "review");
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
    const homeDir = await temporaryHome("review-npm-coexist-");
    const cli = path.join(homeDir, "npm/whiteboard-cli.js");
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
  const homeDir = await temporaryHome("review-uninstall-coexist-");

  const env = {
    DEV_WHITEBOARD_HOME: path.join(homeDir, ".dev"),
    TRACE_R2_MODE: "mock",
  };

  const npm = path.join(homeDir, "npm/bin/review");
  await mkdir(path.dirname(npm), { recursive: true });
  await writeFile(npm, "#!/bin/sh\n", { mode: 0o755 });

  const installed = await applyCliInstall({
    packageRoot,
    targets: [],
    shim: false,
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
    targets: ["claude"],
    shim: true,
    cliPath: path.join(packageRoot, "dist/whiteboard-cli.js"),
    homeDir,
    env,
  });
  expect(await readFile(hook.path, "utf8")).toBe(before);
  await removeCliInstall({
    targets: ["claude"],
    shim: true,
    trace: true,
    homeDir,
    env,
  });
  expect(await readFile(hook.path, "utf8")).toBe(before);
  expect((await traceMachineStatus({ homeDir, env })).enabled).toBe(true);
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
    targets: [],
    shim: true,
    homeDir,
    env,
    packageRoot,
    cliPath,
    cliRuntimePath: process.execPath,
  });

  expect(result.code).toBe(0);
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
