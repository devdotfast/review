import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_PROFILE_MARKER,
  ensureShellProfilePath,
  envFilePath,
  fishEnvFilePath,
  fishSourceLine,
  isExecutableFile,
  pathContainsDirectory,
  posixSourceLine,
  removeShellProfilePath,
  resolvePathCommand,
  shellProfilesWithPathSetup,
} from "./shell-profile";

const run = promisify(execFile);

/** The first executable named `name` on this process's PATH, or null. */
async function findOnPath(name: string): Promise<string | null> {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);

    if (await isExecutableFile(candidate)) return candidate;
  }

  return null;
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

describe("shell profile PATH setup", () => {
  let home: string;
  let devHome: string;
  let shimDirectory: string;
  /** A PATH with no real shell on it, so only `$SHELL` and fakes count. */
  let binDir: string;
  let posixLine: string;
  let fishLine: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dev-traces-profile-"));
    devHome = path.join(home, ".dev");
    shimDirectory = path.join(home, ".local", "bin");
    binDir = path.join(home, "fake-bin");
    await mkdir(binDir);
    posixLine = posixSourceLine(devHome, home);
    fishLine = fishSourceLine(devHome, home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function file(name: string): string {
    return path.join(home, name);
  }

  async function fakeShell(name: string): Promise<void> {
    await writeFile(path.join(binDir, name), "#!/bin/sh\n", { mode: 0o755 });
  }

  function ensure(env: NodeJS.ProcessEnv, customDevHome = devHome) {
    return ensureShellProfilePath({
      homeDir: home,
      devHome: customDevHome,
      env: { PATH: binDir, ...env },
      shimDirectory,
    });
  }

  function remove(env: NodeJS.ProcessEnv = {}) {
    return removeShellProfilePath({
      homeDir: home,
      devHome,
      env: { PATH: binDir, ...env },
    });
  }

  function fishDropIn(configHome = path.join(home, ".config")): string {
    return path.join(configHome, "fish", "conf.d", "dev-traces.fish");
  }

  async function writeDebianHome(): Promise<void> {
    await writeFile(file(".profile"), "export FROM_PROFILE=1\n");
    await writeFile(file(".bashrc"), "# bashrc\n");
  }

  it("spells the default trace home through $HOME", () => {
    expect(posixLine).toBe('. "$HOME/.dev/traces/env"');
    expect(fishLine).toBe('source "$HOME/.dev/traces/env.fish"');
  });

  it("appends to .profile and .bashrc on Debian and never creates .bash_profile", async () => {
    await writeDebianHome();
    const result = await ensure({ SHELL: "/bin/bash" });

    expect(result).toEqual({
      added: [file(".profile"), file(".bashrc")],
      created: [],
      skipped: null,
      output:
        `[ok] added ${file(".profile")} to PATH setup\n` +
        `[ok] added ${file(".bashrc")} to PATH setup\n` +
        `To set up PATH in another shell, run: ${posixLine}\n`,
    });

    expect(await readFile(file(".profile"), "utf8")).toBe(
      `export FROM_PROFILE=1\n${posixLine}\n`,
    );
    expect(await readFile(file(".bashrc"), "utf8")).toBe(
      `# bashrc\n${posixLine}\n`,
    );
    expect(await exists(file(".bash_profile"))).toBe(false);
    expect(await exists(file(".bash_login"))).toBe(false);

    const env = await readFile(envFilePath(devHome), "utf8");
    expect(env).toContain("# Managed by @dev.fast/traces. Do not edit.");
    expect(env).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect((await stat(envFilePath(devHome))).mode & 0o777).toBe(0o644);
    expect(await readFile(fishEnvFilePath(devHome), "utf8")).toContain(
      'set -gx PATH "$HOME/.local/bin" $PATH',
    );
  });

  it("creates only .profile in a bare home and says so for bash", async () => {
    const result = await ensure({ SHELL: "/bin/bash" });
    expect(result.added).toEqual([file(".profile")]);
    expect(result.created).toEqual([file(".profile")]);
    expect(result.output).toContain(`[ok] created ${file(".profile")}\n`);
    expect(result.output).toContain(
      "bash reads ~/.profile at login; no bash rc file was created.\n",
    );
    expect(await readFile(file(".profile"), "utf8")).toBe(`${posixLine}\n`);
    expect(await exists(file(".bash_profile"))).toBe(false);
    expect(await exists(file(".bashrc"))).toBe(false);
  });

  it("writes .zshenv and .profile for zsh and leaves .zshrc alone", async () => {
    await writeFile(file(".zshrc"), "# zshrc\n");
    const result = await ensure({ SHELL: "/bin/zsh" });
    expect(result.added).toEqual([file(".profile"), file(".zshenv")]);
    expect(result.created).toEqual([file(".profile"), file(".zshenv")]);
    expect(await readFile(file(".zshenv"), "utf8")).toBe(`${posixLine}\n`);
    expect(await readFile(file(".zshrc"), "utf8")).toBe("# zshrc\n");
    expect(await exists(file(".zprofile"))).toBe(false);
  });

  it("puts .zshenv under ZDOTDIR", async () => {
    const zdotdir = path.join(home, "zdot");
    const result = await ensure({ SHELL: "/bin/zsh", ZDOTDIR: zdotdir });
    expect(result.created).toContain(path.join(zdotdir, ".zshenv"));
    expect(await readFile(path.join(zdotdir, ".zshenv"), "utf8")).toBe(
      `${posixLine}\n`,
    );
    expect(await exists(file(".zshenv"))).toBe(false);
  });

  it("writes a fish drop-in and .profile for fish", async () => {
    const result = await ensure({ SHELL: "/usr/bin/fish" });
    expect(result.added).toEqual([file(".profile"), fishDropIn()]);
    expect(await readFile(fishDropIn(), "utf8")).toBe(`${fishLine}\n`);
  });

  it("puts the fish drop-in under XDG_CONFIG_HOME", async () => {
    const configHome = path.join(home, "xdg");

    const result = await ensure({
      SHELL: "/usr/bin/fish",
      XDG_CONFIG_HOME: configHome,
    });

    expect(result.created).toContain(fishDropIn(configHome));
  });

  it("detects every shell on PATH when $SHELL is sh", async () => {
    await fakeShell("bash");
    await fakeShell("zsh");
    await fakeShell("fish");
    await writeFile(file(".bashrc"), "# bashrc\n");
    const result = await ensure({ SHELL: "/bin/sh" });

    expect(result.added).toEqual([
      file(".profile"),
      file(".bashrc"),
      file(".zshenv"),
      fishDropIn(),
    ]);
    expect(result.created).toEqual([
      file(".profile"),
      file(".zshenv"),
      fishDropIn(),
    ]);
    expect(await exists(file(".bash_profile"))).toBe(false);
  });

  it("appends nothing on a second run", async () => {
    await writeDebianHome();
    await ensure({ SHELL: "/bin/bash" });
    const second = await ensure({ SHELL: "/bin/bash" });
    expect(second).toEqual({
      added: [],
      created: [],
      skipped: null,
      output: "",
    });
    const profile = await readFile(file(".profile"), "utf8");
    expect(profile.split(posixLine).length - 1).toBe(1);
  });

  it("skips every write when the shim directory is on PATH", async () => {
    const result = await ensure({
      SHELL: "/bin/bash",
      PATH: `${shimDirectory}:${binDir}`,
    });

    expect(result).toEqual({
      added: [],
      created: [],
      skipped: `${shimDirectory} is already on PATH; no shell file was changed`,
      output: `${shimDirectory} is already on PATH; no shell file was changed\n`,
    });
    expect(await exists(file(".profile"))).toBe(false);
    expect(await exists(envFilePath(devHome))).toBe(false);
    expect(await exists(fishEnvFilePath(devHome))).toBe(false);
    expect(
      pathContainsDirectory(`${shimDirectory}:/usr/bin`, shimDirectory),
    ).toBe(true);
  });

  it("skips every write under DEV_TRACES_NO_MODIFY_PATH=1", async () => {
    const result = await ensure({
      SHELL: "/bin/bash",
      DEV_TRACES_NO_MODIFY_PATH: "1",
    });

    expect(result.skipped).toBe(
      "DEV_TRACES_NO_MODIFY_PATH=1 is set; no shell file was changed",
    );
    expect(result.added).toEqual([]);
    expect(await exists(file(".profile"))).toBe(false);
    expect(await exists(envFilePath(devHome))).toBe(false);
  });

  it("puts the line on its own line after a file with no trailing newline", async () => {
    await writeFile(file(".profile"), "export A=1");
    await ensure({ SHELL: "/bin/sh" });
    expect(await readFile(file(".profile"), "utf8")).toBe(
      `export A=1\n${posixLine}\n`,
    );
  });

  it("writes the full path of a custom trace home", async () => {
    const custom = path.join(home, "elsewhere");
    const result = await ensure({ SHELL: "/bin/sh" }, custom);
    expect(result.added).toEqual([file(".profile")]);
    expect(await readFile(file(".profile"), "utf8")).toBe(
      `. "${path.join(custom, "traces", "env")}"\n`,
    );
    expect(await exists(path.join(custom, "traces", "env"))).toBe(true);
  });

  it("keeps a linked profile a link", async () => {
    const dotfiles = path.join(home, "dotfiles", "profile");
    await mkdir(path.dirname(dotfiles), { recursive: true });
    await writeFile(dotfiles, "# mine\n");
    await symlink(dotfiles, file(".profile"));
    await ensure({ SHELL: "/bin/sh" });
    expect(await readFile(dotfiles, "utf8")).toBe(`# mine\n${posixLine}\n`);
    await remove();
    expect(await readFile(dotfiles, "utf8")).toBe("# mine\n");
    expect(await realpath(file(".profile"))).toBe(await realpath(dotfiles));
  });

  it("reports the files that hold the line", async () => {
    await writeDebianHome();
    const input = { homeDir: home, devHome, env: { PATH: binDir } };
    expect(await shellProfilesWithPathSetup(input)).toEqual([]);
    await ensure({ SHELL: "/bin/bash" });
    expect(await shellProfilesWithPathSetup(input)).toEqual([
      file(".profile"),
      file(".bashrc"),
    ]);
  });

  it("uninstalls the line, the drop-in, the env files, and the legacy block", async () => {
    await writeDebianHome();
    await fakeShell("fish");
    await fakeShell("zsh");
    await ensure({ SHELL: "/bin/bash" });

    const legacyBlock = `\n${LEGACY_PROFILE_MARKER}\nexport PATH="$HOME/.local/bin:$PATH"\n`;
    await writeFile(file(".zprofile"), `# zprofile\n${legacyBlock}`);
    // The earlier implementation created this file for the block alone.
    await writeFile(file(".bash_profile"), legacyBlock);
    const dropIn = fishDropIn();

    expect(await remove()).toEqual([
      file(".profile"),
      file(".bash_profile"),
      file(".bashrc"),
      file(".zprofile"),
      file(".zshenv"),
      dropIn,
    ]);

    expect(await readFile(file(".profile"), "utf8")).toBe(
      "export FROM_PROFILE=1\n",
    );
    expect(await readFile(file(".bashrc"), "utf8")).toBe("# bashrc\n");
    expect(await readFile(file(".zprofile"), "utf8")).toBe("# zprofile\n");
    expect(await readFile(file(".zshenv"), "utf8")).toBe("");
    expect(await exists(file(".bash_profile"))).toBe(false);
    expect(await exists(dropIn)).toBe(false);
    expect(await exists(envFilePath(devHome))).toBe(false);
    expect(await exists(fishEnvFilePath(devHome))).toBe(false);
    expect(await remove()).toEqual([]);
  });

  it("keeps a bash login shell reading .profile", async () => {
    const bash = await findOnPath("bash");

    if (!bash) return;
    await writeDebianHome();
    await ensure({ SHELL: bash });

    const { stdout } = await run(
      bash,
      ["-lc", 'echo "$PATH"; echo "$FROM_PROFILE"'],
      { env: { HOME: home, PATH: "/usr/bin:/bin" } },
    );

    const [pathValue, fromProfile] = stdout.split("\n");
    expect(pathValue?.startsWith(`${shimDirectory}:`)).toBe(true);
    expect(fromProfile).toBe("1");
  });

  it("puts the shim directory on PATH in a zsh login shell", async () => {
    const zsh = await findOnPath("zsh");

    if (!zsh) return;
    await writeFile(file(".zprofile"), "export FROM_ZPROFILE=1\n");
    await ensure({ SHELL: zsh, ZDOTDIR: home });

    const { stdout } = await run(
      zsh,
      ["-lc", 'echo "$PATH"; echo "$FROM_ZPROFILE"'],
      { env: { HOME: home, ZDOTDIR: home, PATH: "/usr/bin:/bin" } },
    );

    // On macOS /etc/zprofile runs path_helper after .zshenv, which moves the
    // system directories ahead of ours; the entry is still on PATH.
    const [pathValue, fromZprofile] = stdout.split("\n");
    expect(pathContainsDirectory(pathValue, shimDirectory)).toBe(true);
    expect(fromZprofile).toBe("1");
  });
});

describe("shadowing commands", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dev-traces-shadow-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reports an earlier command and ignores one of ours", async () => {
    const other = path.join(home, "other");
    const shim = path.join(home, ".local", "bin", "dev-traces");
    await writeFile(path.join(home, "dev-traces"), "#!/bin/sh\n", {
      mode: 0o755,
    });

    const env = { PATH: `${home}:${path.dirname(shim)}` };
    expect(await resolvePathCommand("dev-traces", shim, env, "# ours")).toBe(
      path.join(home, "dev-traces"),
    );
    expect(
      await resolvePathCommand("dev-traces", shim, env, "#!/bin/sh"),
    ).toBeUndefined();
    expect(
      await resolvePathCommand("dev-traces", shim, { PATH: other }, "# ours"),
    ).toBeUndefined();
  });

  it("ignores the npx .bin link to the running package", async () => {
    const shim = path.join(home, ".local", "bin", "dev-traces");
    const packageRoot = path.join(home, "npx-cache", "node_modules", "pkg");
    const cli = path.join(packageRoot, "dist", "cli.js");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o755 });

    const bin = path.join(home, "npx-cache", "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await symlink(cli, path.join(bin, "dev-traces"));

    // The install passes the resolved path; on macOS the temp directory is
    // itself a link.
    const ownRealPath = await realpath(cli);
    const env = { PATH: `${bin}:${path.dirname(shim)}` };
    expect(
      await resolvePathCommand("dev-traces", shim, env, "# ours", ownRealPath),
    ).toBeUndefined();

    const foreign = path.join(home, "foreign");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "dev-traces"), "#!/bin/sh\n", {
      mode: 0o755,
    });

    expect(
      await resolvePathCommand(
        "dev-traces",
        shim,
        { PATH: `${foreign}:${bin}:${path.dirname(shim)}` },
        "# ours",
        ownRealPath,
      ),
    ).toBe(path.join(foreign, "dev-traces"));
  });
});
