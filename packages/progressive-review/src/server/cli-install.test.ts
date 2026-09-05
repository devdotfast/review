import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ReviewCliInstallStamp } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  enableTraceRepository,
  traceRepositoryStatus,
} from "../trace-repository-hooks";
import {
  allowTraceRepository,
  readTraceUserConfig,
} from "../trace-user-config";
import {
  applyCliInstall,
  cliInstallStampPath,
  ensureShellProfilePath,
  readCliInstallStamp,
  removeCliInstall,
  removeShellProfilePath,
  resolveCliInstallStatus,
  resolveInstalledReviewAgentStatus,
  skipCliInstall,
} from "./cli-install";
import { writePrivateJsonAtomic } from "./desktop-paths";

const temporaryDirectories: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, "../..");
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
  it("reports capture as enabled only while a repository is allowed", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "review-trace-install-"));
    temporaryDirectories.push(homeDir);
    const devHome = path.join(homeDir, ".dev");
    const env: NodeJS.ProcessEnv = { DEV_REVIEW_HOME: devHome };
    const applied = await applyCliInstall({
      packageRoot,
      targets: [],
      homeDir,
      env,
      trace: true,
    });

    expect(applied.code).toBe(0);
    // The hooks are installed, but no repository may publish traces yet.
    const installed = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env,
    });
    expect(installed.trace).toEqual({ enabled: false });
    expect(installed.stamp?.traceManaged).toBe(true);

    await allowTraceRepository(
      {
        repositoryId: 7,
        name: "acme/app",
        store: "https://app.dev.fast",
      },
      devHome,
    );

    const allowed = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env,
    });
    expect(allowed.trace).toEqual({ enabled: true });

    await removeCliInstall({ targets: [], trace: true, homeDir, env });

    const disabled = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env,
    });
    expect(disabled.trace).toEqual({ enabled: false });
    expect((await readTraceUserConfig(devHome)).repositories).toEqual([]);
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

  it("installs the command and profile by default for a skill target", async () => {
    const homeDir = await temporaryHome("review-default-shim-");
    const env = profileEnvironment(homeDir, "/bin/zsh");
    const cliPath = path.join(homeDir, "cli.js");
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

describe("trace repository uninstall under TRACE_HOME_DIR", () => {
  it("disables repositories registered under TRACE_HOME_DIR during uninstall", async () => {
    const homeSim = await mkdtemp(
      path.join(tmpdir(), "review-trace-home-sim-"),
    );
    const traceHome = await mkdtemp(path.join(tmpdir(), "review-trace-home-"));
    const repo = await mkdtemp(path.join(tmpdir(), "review-trace-repo-"));
    temporaryDirectories.push(homeSim, traceHome, repo);
    await runGit(repo, ["init", "-b", "main"]);

    const prevHome = process.env.HOME;
    const prevTrace = process.env.TRACE_HOME_DIR;
    process.env.HOME = homeSim;
    process.env.TRACE_HOME_DIR = traceHome;
    try {
      const enabled = await enableTraceRepository({
        cwd: repo,
        reviewCommand: "review",
      });
      expect(enabled.enabled).toBe(true);
      expect((await traceRepositoryStatus(repo)).enabled).toBe(true);

      expect(
        await readFile(
          path.join(traceHome, ".config", "dev-trace", "repositories.json"),
          "utf8",
        ),
      ).toContain(repo);
      await expect(
        readFile(
          path.join(homeSim, ".config", "dev-trace", "repositories.json"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await removeCliInstall({
        targets: [],
        trace: true,
        env: { HOME: homeSim, TRACE_HOME_DIR: traceHome },
      });

      expect((await traceRepositoryStatus(repo)).enabled).toBe(false);
    } finally {
      process.env.HOME = prevHome;
      if (prevTrace === undefined) delete process.env.TRACE_HOME_DIR;
      else process.env.TRACE_HOME_DIR = prevTrace;
    }
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

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}
