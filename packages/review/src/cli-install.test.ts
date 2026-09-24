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

import type { ReviewCliInstallStamp } from "@dev.fast/review-protocol";
import {
  enableTraceRepository,
  installClaudeTraceHook,
  traceMachineStatus,
  traceRepositoryStatus,
  traceScope,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCliInstall,
  cliInstallStampPath,
  cliInstallUpdateMarkerPath,
  ensureShellProfilePath,
  finishCliInstallUpdate,
  installReviewCommand,
  pathShimPath,
  readCliInstallStamp,
  removeCliInstall,
  removeLegacyReviewSkills,
  removeShellProfilePath,
  resetCliInstall,
  resolveCliInstallStatus,
  skipCliInstall,
  writePathShim,
} from "./cli-install";
import { reviewMcpLaunch } from "./connect-prompts";
import { cursorInstallDeeplink } from "./cursor-deeplink";

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

describe("review command installation", () => {
  it("preserves a command symlink and its target", async () => {
    const homeDir = await temporaryHome("review-cli-symlink-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "current-app", "cli.js");
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
    const homeDir = await temporaryHome("review-cli-only-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "current-app", "cli.js");
    const shimPath = path.join(homeDir, ".local", "bin", "whiteboard");
    await Promise.all([
      mkdir(path.dirname(cliPath), { recursive: true }),
      mkdir(path.dirname(shimPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(cliPath, "// current CLI\n"),
      writeFile(
        shimPath,
        "#!/bin/sh\n# Managed by Whiteboard Desktop\nFALLBACK_CLI='/Applications/Old Review.app/cli.js'\n",
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
    expect(installed).not.toContain("Old Review.app");
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
    const homeDir = await temporaryHome("review-empty-apply-");
    const env = profileEnvironment(homeDir, "/bin/zsh");

    expect(await applyCliInstall({ packageRoot, homeDir, env })).toEqual({
      code: 0,
      output: "",
    });
    expect(await readCliInstallStamp(cliInstallStampPath(env))).toBeNull();
  });

  it("keeps a removed command removed until it is installed explicitly", async () => {
    const homeDir = await temporaryHome("review-disabled-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const builtRoot = await builtPackageRoot();
    const cliPath = path.join(builtRoot, "dist", "cli.js");
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

    await writeFile(path.join(builtRoot, "dist", "cli.js"), "// next build\n");
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
    const homeDir = await temporaryHome("review-missing-explicit-cli-");
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

  it("warns when another review command comes first on PATH", async () => {
    const homeDir = await temporaryHome("review-shadowed-command-");
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
    const homeDir = await temporaryHome("review-remove-command-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "cli.js");
    await writeFile(cliPath, "// test CLI\n");
    await applyCliInstall({ packageRoot, shim: true, cliPath, homeDir, env });

    const removed = await removeCliInstall({ shim: true, homeDir, env });

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
    const shim = path.join(homeDir, ".local", "bin", "whiteboard");
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
    ["instance management", true, true, false, "fallback"],
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
          serverPid: process.pid,
        }),
      );
      await writePathShim(shim, fallbackCli, fallbackRuntime, home);

      const args =
        _name === "instance management"
          ? ["instances", "use", "preview"]
          : ["trace", "status"];

      const { stdout } = await promisify(execFile)(shim, args, {
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
        ...args,
      ]);
    },
  );
});

describe("installed launcher instance selection", () => {
  // A dead pid: the shim must not trust a record whose server has exited.
  const deadPid = 2 ** 22 + 1;

  async function fixture(records: Record<string, number>) {
    const home = await temporaryHome("review-shim-instances-");
    const shim = path.join(home, "review");
    const fallbackCli = path.join(home, "fallback-cli.js");
    const fallbackRuntime = path.join(home, "fallback-runtime");
    await writeFile(fallbackCli, "// CLI fixture\n");
    await writeFile(fallbackRuntime, "#!/bin/sh\necho fallback\n", {
      mode: 0o755,
    });
    const instances = path.join(home, "review-desktop", "instances");
    await mkdir(instances, { recursive: true });

    for (const [key, serverPid] of Object.entries(records)) {
      const file =
        key === "legacy"
          ? path.join(home, "review-desktop", "server.json")
          : path.join(instances, `${key}.json`);

      const cliPath = path.join(home, `${key}-cli.js`);
      const cliRuntimePath = path.join(home, `${key}-runtime`);
      await writeFile(cliPath, "// CLI fixture\n");
      await writeFile(cliRuntimePath, `#!/bin/sh\necho ${key}\n`, {
        mode: 0o755,
      });
      await writeFile(
        file,
        JSON.stringify({ cliPath, cliRuntimePath, serverPid }),
      );
    }

    await writePathShim(shim, fallbackCli, fallbackRuntime, home);

    return async (env: NodeJS.ProcessEnv = {}, defaultInstance?: string) => {
      if (defaultInstance)
        await writeFile(
          path.join(home, "review-desktop", "default-instance"),
          `${defaultInstance}\n`,
        );

      const { stdout } = await promisify(execFile)(shim, [], {
        env: {
          PATH: process.env.PATH,
          DEV_REVIEW_HOME: home,
          DEV_REVIEW_INSTANCE: "",
          ...env,
        },
      });

      return stdout.trim();
    };
  }

  it("follows the env override, then the machine default, then the only live Desktop, then stable", async () => {
    const both = await fixture({ stable: process.pid, preview: process.pid });
    expect(await both({ DEV_REVIEW_INSTANCE: "preview" })).toBe("preview");
    expect(await both()).toBe("stable");
    expect(await both({}, "preview")).toBe("preview");
    expect(await both({ DEV_REVIEW_INSTANCE: "stable" }, "preview")).toBe(
      "stable",
    );

    const previewOnly = await fixture({
      stable: deadPid,
      preview: process.pid,
    });

    expect(await previewOnly()).toBe("preview");
    expect(await previewOnly({ DEV_REVIEW_INSTANCE: "stable" })).toBe(
      "fallback",
    );

    // A pre-instance stable Desktop answers only for stable.
    const legacy = await fixture({ legacy: process.pid });
    expect(await legacy()).toBe("legacy");
    expect(await legacy({ DEV_REVIEW_INSTANCE: "stable" })).toBe("legacy");
    expect(await legacy({ DEV_REVIEW_INSTANCE: "preview" })).toBe("fallback");

    // A key is a file name; anything else is left for the CLI to reject.
    expect(await both({ DEV_REVIEW_INSTANCE: "../server" })).toBe("fallback");
  });
});

describe("Desktop installation alongside npm", () => {
  it("preserves the npm launcher and its target when npm uses ~/.local/bin", async () => {
    const homeDir = await temporaryHome("review-npm-coexist-");
    const cli = path.join(homeDir, "npm/cli.js");
    const shim = path.join(homeDir, ".local/bin/whiteboard");
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
    cliPath: path.join(packageRoot, "dist/cli.js"),
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
  const root = await temporaryHome("review-built-package-");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"version":"1.2.3"}\n');
  await writeFile(path.join(root, "dist", "cli.js"), "// built CLI\n");

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
    homeDir = await temporaryHome("review-self-install-");
    env = profileEnvironment(homeDir, "/bin/zsh");
    builtRoot = await builtPackageRoot();
    cliPath = path.join(builtRoot, "dist", "cli.js");
    shim = pathShimPath(homeDir);
  });

  const writeStamp = (stamp: ReviewCliInstallStamp & { targets?: string[] }) =>
    writePrivateJsonAtomic(cliInstallStampPath(env), stamp);

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

    it.each([null, "granted", "declined", "skipped"] as const)(
      "requires the update while legacy skills remain with consent %s, even after Done",
      async (consent) => {
        if (consent) await writeStamp({ consent, updatedAt: now });
        await writeStampedSkill(
          path.join(homeDir, ".agents", "skills", "dev-review"),
        );
        const input = { packageRoot: builtRoot, homeDir, env };

        expect((await resolveCliInstallStatus(input)).updateNeeded).toBe(true);
        await mkdir(path.dirname(cliInstallUpdateMarkerPath(env)), {
          recursive: true,
        });
        await writeFile(cliInstallUpdateMarkerPath(env), "");
        await finishCliInstallUpdate(env);
        expect((await resolveCliInstallStatus(input)).updateNeeded).toBe(true);

        await removeLegacyReviewSkills({ homeDir, env });
        expect((await resolveCliInstallStatus(input)).updateNeeded).toBe(false);
        expect(
          (await readCliInstallStamp(cliInstallStampPath(env)))?.consent,
        ).toBe(consent ?? undefined);
      },
    );

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
    });

    it("offers each harness's plugin, with the Cursor link only when the shim exists", async () => {
      await writePathShim(shim, cliPath, undefined, path.join(homeDir, ".dev"));

      const built = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      const { plugins } = built.connect;

      expect(plugins.opencode.command).toContain(
        "@dev.fast/opencode-whiteboard",
      );
      expect(plugins.cursor).toEqual({
        label: "Install in Cursor",
        url: cursorInstallDeeplink(reviewMcpLaunch(true)),
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

    it("lists Review-stamped legacy skills", async () => {
      await writeStampedSkill(
        path.join(homeDir, ".claude", "skills", "dev-review"),
      );

      const status = await resolveCliInstallStatus({
        packageRoot: builtRoot,
        homeDir,
        env,
      });

      expect(status.legacySkills).toEqual([
        { path: "~/.claude/skills/dev-review" },
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

  describe("removeLegacyReviewSkills", () => {
    it("removes stamped skills and the status no longer lists them", async () => {
      await writeStampedSkill(
        path.join(homeDir, ".agents", "skills", "scratchpad"),
      );

      const { removed } = await removeLegacyReviewSkills({ homeDir, env });

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

it("retargets enabled repository hooks before removing the owned legacy launcher", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "review-shim-trace-"));
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
    DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
    TRACE_SETTINGS_FILE: settings,
    DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
  };

  const oldCommand = path.join(homeDir, ".local", "bin", "review");
  await mkdir(path.dirname(oldCommand), { recursive: true });
  await writeFile(
    oldCommand,
    "#!/bin/sh\n# Managed by Whiteboard Desktop\nexit 1\n",
    { mode: 0o755 },
  );
  await enableTraceRepository({
    cwd,
    scope: traceScope({ homeDir, env }),
    reviewCommand: oldCommand,
  });
  const cliPath = path.join(homeDir, "cli.js");
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
  await expect(lstat(oldCommand)).rejects.toMatchObject({ code: "ENOENT" });
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
