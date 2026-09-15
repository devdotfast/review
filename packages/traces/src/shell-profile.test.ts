import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROFILE_EXPORT,
  PROFILE_MARKER,
  ensureShellProfilePath,
  pathContainsDirectory,
  removeShellProfilePath,
  resolvePathCommand,
} from "./shell-profile";

describe("shell profile PATH block", () => {
  let home: string;
  let shimDirectory: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dev-traces-profile-"));
    shimDirectory = path.join(home, ".local", "bin");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function ensure(shell: string, pathValue = "/usr/bin:/bin") {
    return ensureShellProfilePath({
      homeDir: home,
      env: { SHELL: shell, PATH: pathValue },
      shimDirectory,
      platform: "linux",
    });
  }

  it("writes the block to .zprofile for zsh", async () => {
    const result = await ensure("/bin/zsh");
    expect(result).toEqual({
      added: true,
      output: `[ok] added ${shimDirectory} to PATH in ${path.join(home, ".zprofile")}\n`,
    });
    const profile = await readFile(path.join(home, ".zprofile"), "utf8");
    expect(profile).toContain(PROFILE_MARKER);
    expect(profile).toContain(PROFILE_EXPORT);
  });

  it("writes the block to .bash_profile for bash", async () => {
    await ensure("/bin/bash");
    expect(await readFile(path.join(home, ".bash_profile"), "utf8")).toContain(
      PROFILE_MARKER,
    );
  });

  it("writes no block for fish and explains the manual step", async () => {
    const result = await ensure("/usr/bin/fish");
    expect(result.added).toBe(false);
    expect(result.output).toContain("fish_add_path ~/.local/bin");
    await expect(
      readFile(path.join(home, ".zprofile"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes the block once and removes it once", async () => {
    await ensure("/bin/zsh");
    expect(await ensure("/bin/zsh")).toEqual({ added: false, output: "" });
    const profilePath = path.join(home, ".zprofile");
    const profile = await readFile(profilePath, "utf8");
    expect(profile.split(PROFILE_MARKER).length - 1).toBe(1);

    expect(await removeShellProfilePath(home)).toEqual([profilePath]);
    expect(await readFile(profilePath, "utf8")).not.toContain(PROFILE_MARKER);
    expect(await removeShellProfilePath(home)).toEqual([]);
  });

  it("writes no block when PATH already reaches the directory", async () => {
    expect(await ensure("/bin/zsh", `${shimDirectory}:/usr/bin`)).toEqual({
      added: false,
      output: "",
    });
    expect(
      pathContainsDirectory(`${shimDirectory}:/usr/bin`, shimDirectory),
    ).toBe(true);
  });

  it("writes no block when the profile already names .local/bin", async () => {
    const profilePath = path.join(home, ".zprofile");
    await writeFile(profilePath, 'export PATH="$HOME/.local/bin:$PATH"\n');
    expect(await ensure("/bin/zsh")).toEqual({ added: false, output: "" });
    expect(await readFile(profilePath, "utf8")).not.toContain(PROFILE_MARKER);
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
