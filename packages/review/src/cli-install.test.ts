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
  type ReviewCliInstallStamp,
  reviewCliInstallResyncRequest,
} from "@dev.fast/review-protocol";
import {
  installClaudeTraceHook,
  traceMachineStatus,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCliInstall,
  cliInstallStampPath,
  ensureShellProfilePath,
  installReviewCommand,
  readCliInstallStamp,
  removeCliInstall,
  removeRetiredReviewSkills,
  removeShellProfilePath,
  resolveCliInstallStatus,
  resolveInstalledReviewAgentStatus,
  skipCliInstall,
  writePathShim,
} from "./cli-install";

const temporaryDirectories: string[] = [];

const packageRoot = path.resolve(import.meta.dirname, "..");

const profileMarker =
  "# Managed by Review Desktop: review command PATH. Do not edit.";

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
      } satisfies ReviewCliInstallStamp;

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
      env: { DEV_REVIEW_HOME: path.join(homeDir, ".dev") },
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
      DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
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
      DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
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
    const cliPath = path.join(homeDir, "current-app", "cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "review");
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
    const cliPath = path.join(homeDir, "current-app", "cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "review");
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

  it("keeps a removed command removed until it is installed explicitly", async () => {
    const homeDir = await temporaryHome("review-disabled-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "review");
    await writeFile(cliPath, "// test CLI\n");

    await applyCliInstall({
      packageRoot,
      targets: ["pi"],
      cliPath,
      homeDir,
      env,
    });
    await removeCliInstall({ targets: [], shim: true, homeDir, env });
    expect(existsSync(shimPath)).toBe(false);

    await applyCliInstall({
      packageRoot,
      targets: ["codex"],
      cliPath,
      homeDir,
      env,
    });
    expect(existsSync(shimPath)).toBe(false);

    await applyCliInstall({
      packageRoot,
      targets: [],
      shim: true,
      cliPath,
      homeDir,
      env,
    });
    expect(existsSync(shimPath)).toBe(true);

    await applyCliInstall({
      packageRoot,
      targets: ["claude"],
      cliPath,
      homeDir,
      env,
    });
    expect(existsSync(shimPath)).toBe(true);
  });

  it("installs the command and profile by default for a skill target", async () => {
    const homeDir = await temporaryHome("review-default-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "cli.js");
    await writeFile(cliPath, "// test CLI\n");

    const applied = await applyCliInstall({
      packageRoot,
      targets: ["pi"],
      cliPath,
      homeDir,
      env,
    });

    expect(applied).toMatchObject({
      code: 0,
      shimPath: path.join(homeDir, ".local", "bin", "review"),
    });
    expect(applied.output).toContain("review command");
    expect(await readFile(applied.shimPath!, "utf8")).toContain(
      "Managed by Review Desktop",
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
      readFile(path.join(homeDir, ".local", "bin", "review"), "utf8"),
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
    expect(applied.output).toContain("Agent setup completed");
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
    const cliPath = path.join(homeDir, "cli.js");
    await mkdir(foreignBin, { recursive: true });
    await Promise.all([
      writeFile(cliPath, "// test CLI\n"),
      writeFile(path.join(foreignBin, "review"), "#!/bin/sh\n", {
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

    expect(applied.output).toContain(path.join(foreignBin, "review"));
    expect(applied.output).toContain(
      "docs/troubleshooting.md#the-command-opens-a-browser-or-shows-old-options",
    );
  });

  it("removes the owned command and profile block", async () => {
    const homeDir = await temporaryHome("review-remove-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "cli.js");
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
      readFile(path.join(homeDir, ".local", "bin", "review"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(homeDir, ".zprofile"), "utf8")).toBe("");
  });

  it("preserves a foreign command while removing the managed profile block", async () => {
    const homeDir = await temporaryHome("review-foreign-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const shimPath = path.join(homeDir, ".local", "bin", "review");
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

describe("resolveInstalledReviewAgentStatus", () => {
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
      DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
      PATH: binDir,
    };

    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { review: { command: "custom-review" } } }),
    );

    const status = await resolveInstalledReviewAgentStatus({
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

  return { DEV_REVIEW_HOME: directory };
}

async function temporaryHome(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);

  return directory;
}

function profileEnvironment(homeDir: string, shell: string): NodeJS.ProcessEnv {
  return {
    DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
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
      'console.log(JSON.stringify({build:"current",home:process.env.DEV_REVIEW_HOME}))',
    );
    const shim = path.join(homeDir, ".local", "bin", "review");
    await writePathShim(
      shim,
      oldCli,
      process.execPath,
      path.join(homeDir, "old-profile"),
    );
    const env = profileEnvironment(homeDir, "/bin/zsh");
    await installReviewCommand({
      homeDir,
      env,
      cliPath,
      cliRuntimePath: process.execPath,
    });

    const { stdout } = await promisify(execFile)(shim, [], {
      env: { PATH: "/usr/bin:/bin", DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1" },
    });

    expect(JSON.parse(stdout)).toEqual({
      build: "current",
      home: env.DEV_REVIEW_HOME,
    });
  });

  it("retains the installed profile when invoked without the setup environment", async () => {
    const home = await temporaryHome("review-profile-shim-");
    const profile = path.join(home, "a profile");
    const cli = path.join(home, "cli.cjs");
    const shim = path.join(home, "review");
    await writeFile(cli, "console.log(process.env.DEV_REVIEW_HOME)");
    await writePathShim(shim, cli, process.execPath, profile);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.DEV_REVIEW_HOME;

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
        '#!/bin/sh\nprintf "%s\\n" "fallback" "guard=$DEV_FAST_REVIEW_CLI_NO_DELEGATE" "delegated=$DEV_FAST_REVIEW_CLI_DELEGATED" "$@"\n',
        { mode: 0o755 },
      );

      if (cliExists) await writeFile(discoveredCli, "// CLI fixture\n");

      if (runtimeExists)
        await writeFile(
          discoveredRuntime,
          '#!/bin/sh\nprintf "%s\\n" "discovered" "guard=$DEV_FAST_REVIEW_CLI_NO_DELEGATE" "delegated=$DEV_FAST_REVIEW_CLI_DELEGATED" "$@"\n',
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
          DEV_REVIEW_HOME: home,
          DEV_FAST_REVIEW_CLI_NO_DELEGATE: noDelegate ? "1" : "",
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
    const cli = path.join(homeDir, "npm/cli.js");
    const shim = path.join(homeDir, ".local/bin/review");
    await mkdir(path.dirname(cli), { recursive: true });
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(cli, "#!/usr/bin/env node\n// npm-owned\n", {
      mode: 0o755,
    });
    await symlink(cli, shim);
    const before = await readFile(cli, "utf8");

    const result = await installReviewCommand({
      homeDir,
      cliPath: path.join(packageRoot, "dist/cli.js"),
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
    DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
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
    cliPath: path.join(packageRoot, "dist/cli.js"),
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

async function seedManagedSkill(
  homeDir: string,
  root: string,
  name = "dev-review",
) {
  const file = path.join(homeDir, root, "skills", name, "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: managed\nmetadata:\n  review-managed-by: "Review Desktop"\n  review-generated: "generated"\n  review-version: "1.0.0"\n---\n`,
  );

  return file;
}

it("resyncs owned legacy skills once without changing MCP readiness", async () => {
  const homeDir = await temporaryHome("review-skill-migration-");
  const env = profileEnvironment(homeDir, "/bin/sh");

  const input = {
    packageRoot,
    homeDir,
    env,
    cliPath: path.join(packageRoot, "dist/cli.js"),
    shim: false,
    targets: ["claude"] as const,
  };

  expect(
    (await applyCliInstall({ ...input, targets: [...input.targets] })).code,
  ).toBe(0);
  const skill = await seedManagedSkill(homeDir, ".claude");
  const before = await resolveCliInstallStatus(input);
  expect(before.stale).toBe(true);
  expect(
    before.agents.find((agent) => agent.target === "claude")?.installed,
  ).toBe(true);
  expect(
    (
      await applyCliInstall({
        ...input,
        targets: [...input.targets],
        autoUpdate: true,
      })
    ).code,
  ).toBe(0);
  expect((await resolveCliInstallStatus(input)).stale).toBe(false);
  await expect(readFile(skill)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps the managed Pi skill when connecting and removing Codex", async () => {
  const homeDir = await temporaryHome("review-pi-codex-");
  const env = profileEnvironment(homeDir, "/bin/sh");

  const input = {
    packageRoot,
    homeDir,
    env,
    cliPath: path.join(packageRoot, "dist/cli.js"),
    shim: false,
  };

  expect((await applyCliInstall({ ...input, targets: ["pi"] })).code).toBe(0);
  const file = path.join(homeDir, ".agents/skills/dev-review/SKILL.md");
  const initial = await readFile(file, "utf8");
  expect((await applyCliInstall({ ...input, targets: ["codex"] })).code).toBe(
    0,
  );
  expect(await readFile(file, "utf8")).toBe(initial);
  expect((await resolveCliInstallStatus(input)).stale).toBe(false);
  await removeCliInstall({ ...input, targets: ["codex"] });
  expect(await readFile(file, "utf8")).toBe(initial);
  expect((await resolveCliInstallStatus(input)).stamp?.targets).toEqual(["pi"]);
  await removeCliInstall({ ...input, targets: ["pi"] });
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("migrates legacy consent without targets using owned MCP skills only", async () => {
  const homeDir = await temporaryHome("review-legacy-consent-");
  const env = profileEnvironment(homeDir, "/bin/sh");

  const input = {
    packageRoot,
    homeDir,
    env,
    cliPath: path.join(packageRoot, "dist/cli.js"),
    shim: false,
  };

  const claudeSkill = await seedManagedSkill(homeDir, ".claude");
  const codexSkill = await seedManagedSkill(homeDir, ".agents");
  await writePrivateJsonAtomic(cliInstallStampPath(env), {
    consent: "granted",
    updatedAt: new Date().toISOString(),
  });
  const before = await resolveCliInstallStatus(input);
  expect(before.stale).toBe(true);
  expect(
    before.agents.find((agent) => agent.target === "claude")?.installed,
  ).toBe(false);
  expect(
    [...(reviewCliInstallResyncRequest(before)?.targets ?? [])].sort(),
  ).toEqual(["claude", "codex"]);

  expect(
    (await applyCliInstall({ ...input, targets: [], autoUpdate: true })).code,
  ).toBe(0);
  const after = await resolveCliInstallStatus(input);
  expect(after.stale).toBe(false);
  expect(after.stamp?.targets?.sort()).toEqual(["claude", "codex"]);

  for (const file of [claudeSkill, codexSkill])
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes old Review skills at startup even when setup was declined", async () => {
  const homeDir = await temporaryHome("review-startup-cleanup-");
  const env = profileEnvironment(homeDir, "/bin/sh");

  await writePrivateJsonAtomic(cliInstallStampPath(env), {
    consent: "declined",
    updatedAt: "2026-09-01T00:00:00.000Z",
  } satisfies ReviewCliInstallStamp);

  const claude = await seedManagedSkill(homeDir, ".claude");
  const codex = await seedManagedSkill(homeDir, ".agents");
  const trace = await seedManagedSkill(homeDir, ".agents", "trace-archaeology");

  expect(await removeRetiredReviewSkills({ homeDir, env })).toHaveLength(3);

  for (const file of [claude, codex, trace])
    expect(existsSync(file)).toBe(false);
});

it("keeps Pi's pointer at startup while Pi is in use, and only then reports Pi", async () => {
  const homeDir = await temporaryHome("review-startup-pi-");
  const env = profileEnvironment(homeDir, "/bin/sh");
  const pointer = await seedManagedSkill(homeDir, ".agents");

  // An old Codex copy in the shared root is not a Pi install.
  expect(
    (await resolveInstalledReviewAgentStatus({ homeDir, env })).agents.find(
      (agent) => agent.target === "pi",
    )?.installed,
  ).toBe(false);

  await mkdir(path.join(homeDir, ".pi"));
  await removeRetiredReviewSkills({ homeDir, env });
  expect(existsSync(pointer)).toBe(true);
  expect(
    (await resolveInstalledReviewAgentStatus({ homeDir, env })).agents.find(
      (agent) => agent.target === "pi",
    )?.installed,
  ).toBe(true);
});

it("cleans the shared skills root at startup when the stamp never named its agents", async () => {
  const homeDir = await temporaryHome("review-startup-shared-root-");
  const env = profileEnvironment(homeDir, "/bin/sh");

  await writePrivateJsonAtomic(cliInstallStampPath(env), {
    consent: "granted",
    targets: ["claude", "cursor", "opencode"],
    updatedAt: "2026-09-01T00:00:00.000Z",
  } satisfies ReviewCliInstallStamp);

  const trace = await seedManagedSkill(homeDir, ".agents", "trace-archaeology");

  const custom = path.join(
    homeDir,
    ".agents",
    "skills",
    "my-skill",
    "SKILL.md",
  );

  await mkdir(path.dirname(custom), { recursive: true });
  await writeFile(custom, "---\nname: my-skill\ndescription: mine\n---\n");

  await removeRetiredReviewSkills({ homeDir, env });

  expect(existsSync(trace)).toBe(false);
  expect(existsSync(custom)).toBe(true);
});

it("keeps legacy-consent agents connectable when startup cleanup runs before the resync", async () => {
  const homeDir = await temporaryHome("review-legacy-cleanup-order-");
  const env = profileEnvironment(homeDir, "/bin/sh");

  const input = {
    packageRoot,
    homeDir,
    env,
    cliPath: path.join(packageRoot, "dist/cli.js"),
    shim: false,
  };

  await seedManagedSkill(homeDir, ".claude");
  await seedManagedSkill(homeDir, ".agents");
  await writePrivateJsonAtomic(cliInstallStampPath(env), {
    consent: "granted",
    updatedAt: new Date().toISOString(),
  });

  await removeRetiredReviewSkills({ homeDir, env });

  const status = await resolveCliInstallStatus(input);
  expect(
    [...(reviewCliInstallResyncRequest(status)?.targets ?? [])].sort(),
  ).toEqual(["claude", "codex"]);
  expect(
    (await applyCliInstall({ ...input, targets: [], autoUpdate: true })).code,
  ).toBe(0);
  expect(
    (await resolveCliInstallStatus(input)).mcp
      ?.filter((item) => item.state === "ready")
      .map((item) => item.target)
      .sort(),
  ).toEqual(["claude", "codex"]);
});
