import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SHIM_MARKER,
  currentLink,
  installSelf,
  installStatePath,
  selfInstallStatus,
  shimPath,
  uninstallSelf,
} from "./self-install";
import { PROFILE_EXPORT, PROFILE_MARKER } from "./shell-profile";

const run = promisify(execFile);

// The fake package prints its arguments, so a run through the shim proves the
// shim found the installed copy and the runtime.
const FAKE_CLI = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.TRACE_TEST_LOG, process.argv.slice(2).join(" ") + "\\n");
`;

describe("self install", () => {
  let home: string;
  let devHome: string;
  let packageRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "dev-traces-install-"));
    devHome = path.join(home, ".dev");

    // The npx cache layout: the copy must survive the cache going away, and
    // the "node_modules" in this path must not confuse the copy filter.
    packageRoot = path.join(
      home,
      "npx-cache",
      "node_modules",
      "@dev.fast",
      "traces",
    );

    env = {
      HOME: home,
      DEV_REVIEW_HOME: devHome,
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
    };
    await writeFakePackage("0.1.0");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeFakePackage(version: string): Promise<void> {
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });

    await mkdir(path.join(packageRoot, "node_modules", "junk"), {
      recursive: true,
    });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@dev.fast/traces", version, type: "module" }),
    );
    await writeFile(path.join(packageRoot, "dist", "cli.js"), FAKE_CLI);
  }

  function install(force = false) {
    return installSelf({
      packageRoot,
      homeDir: home,
      env,
      devHome,
      execPath: process.execPath,
      force,
    });
  }

  function versionDir(version: string): string {
    return path.join(devHome, "traces", "versions", version);
  }

  it("copies the package, links current, writes the shim and the PATH block", async () => {
    const result = await install();
    expect(result).toMatchObject({
      version: "0.1.0",
      copied: true,
      shimPath: shimPath(home),
      installedRoot: versionDir("0.1.0"),
    });
    expect(result.output).toContain(
      `[ok] dev-traces command -> ${shimPath(home)}\n`,
    );

    const installed = await readdir(versionDir("0.1.0"));
    expect(installed).toEqual(expect.arrayContaining(["dist", "package.json"]));
    expect(installed).not.toContain("node_modules");
    expect(await readlink(currentLink(devHome))).toBe(
      path.join("versions", "0.1.0"),
    );

    const shim = await readFile(shimPath(home), "utf8");
    expect(shim).toContain(SHIM_MARKER);
    expect(shim).toContain(`'${process.execPath}'`);
    expect((await stat(shimPath(home))).mode & 0o777).toBe(0o755);

    const state = JSON.parse(await readFile(installStatePath(devHome), "utf8"));
    expect(state).toMatchObject({
      version: "0.1.0",
      shimPath: shimPath(home),
      runtimePath: process.execPath,
    });
    expect(Date.parse(state.installedAt)).not.toBeNaN();

    const profile = await readFile(path.join(home, ".zprofile"), "utf8");
    expect(profile).toContain(PROFILE_MARKER);
    expect(profile).toContain(PROFILE_EXPORT);
    expect(profile.split(PROFILE_MARKER).length - 1).toBe(1);
  });

  it("copies once and recopies only with force", async () => {
    await install();
    expect((await install()).copied).toBe(false);
    expect((await install(true)).copied).toBe(true);
    const profile = await readFile(path.join(home, ".zprofile"), "utf8");
    expect(profile.split(PROFILE_MARKER).length - 1).toBe(1);
  });

  it("repoints current on a version bump and keeps the old version", async () => {
    await install();
    await writeFakePackage("0.2.0");
    expect((await install()).copied).toBe(true);
    expect(await readlink(currentLink(devHome))).toBe(
      path.join("versions", "0.2.0"),
    );
    expect(
      (await readdir(path.join(devHome, "traces", "versions"))).sort(),
    ).toEqual(["0.1.0", "0.2.0"]);
  });

  it("keeps the current version and two earlier ones", async () => {
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      await writeFakePackage(version);
      await install();
    }

    expect(
      (await readdir(path.join(devHome, "traces", "versions"))).sort(),
    ).toEqual(["0.2.0", "0.3.0", "0.4.0"]);
  });

  it("runs a hook through the shim after the npx cache is gone", async () => {
    await install();
    await rm(path.join(home, "npx-cache"), { recursive: true, force: true });
    const log = path.join(home, "hook.log");
    await run("/bin/sh", [shimPath(home), "trace", "hook", "SessionStart"], {
      env: {
        ...env,
        DEV_TRACES_NODE: process.execPath,
        TRACE_TEST_LOG: log,
      },
    });
    expect(await readFile(log, "utf8")).toBe("trace hook SessionStart\n");
  });

  it("exits 0 without output in hook mode when the install is gone", async () => {
    await install();
    await rm(currentLink(devHome), { force: true });
    const shimEnv = { ...env, DEV_TRACES_NODE: process.execPath };

    const hook = await run(
      "/bin/sh",
      [shimPath(home), "trace", "hook", "SessionEnd"],
      { env: shimEnv },
    );

    expect(hook.stdout + hook.stderr).toBe("");

    await expect(
      run("/bin/sh", [shimPath(home), "status"], { env: shimEnv }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("not installed"),
    });
  });

  it("uninstalls its own files and keeps a foreign dev-traces command", async () => {
    await install();
    await mkdir(path.join(devHome, "trace"), { recursive: true });
    await writeFile(path.join(devHome, "auth.json"), '{"token":"t"}\n');
    await writeFile(path.join(devHome, "trace", "config.json"), "{}\n");

    const result = await uninstallSelf({ homeDir: home, env, devHome });
    expect(result).toMatchObject({
      removedShim: true,
      keptForeignShim: false,
      profiles: [path.join(home, ".zprofile")],
    });
    await expect(stat(shimPath(home))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(devHome, "traces"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(home, ".zprofile"), "utf8")).not.toContain(
      PROFILE_MARKER,
    );
    expect(await readFile(path.join(devHome, "auth.json"), "utf8")).toContain(
      "token",
    );
    expect(
      await readFile(path.join(devHome, "trace", "config.json"), "utf8"),
    ).toBe("{}\n");

    await mkdir(path.dirname(shimPath(home)), { recursive: true });
    await writeFile(shimPath(home), "#!/bin/sh\necho someone else\n");
    const second = await uninstallSelf({ homeDir: home, env, devHome });
    expect(second).toMatchObject({ removedShim: false, keptForeignShim: true });
    expect(await readFile(shimPath(home), "utf8")).toContain("someone else");
  });

  it("backs up a command file it did not write", async () => {
    const foreign = "#!/bin/sh\necho someone else\n";
    const binDir = path.dirname(shimPath(home));
    await mkdir(binDir, { recursive: true });
    await writeFile(shimPath(home), foreign, { mode: 0o755 });

    const result = await install();

    const backups = (await readdir(binDir)).filter((name) =>
      name.startsWith("dev-traces.bak-"),
    );

    expect(backups).toHaveLength(1);
    const backup = path.join(binDir, backups[0]!);
    expect(await readFile(backup, "utf8")).toBe(foreign);
    expect(result.output).toContain(
      `[warn] moved your existing ~/.local/bin/dev-traces to ${backup}\n`,
    );
    expect(await readFile(shimPath(home), "utf8")).toContain(SHIM_MARKER);

    // A shim of ours is never backed up, so a second install keeps one backup.
    await install();
    expect(
      (await readdir(binDir)).filter((name) =>
        name.startsWith("dev-traces.bak-"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the installed entry in place through a force reinstall", async () => {
    await install();
    expect((await install(true)).copied).toBe(true);
    await expect(
      stat(path.join(currentLink(devHome), "dist", "cli.js")),
    ).resolves.toBeDefined();

    const entries = await readdir(path.join(devHome, "traces", "versions"));
    expect(
      entries.some((name) => name.includes(".old-") || name.includes(".tmp-")),
    ).toBe(false);
  });

  it("runs through the baked runtime when DEV_TRACES_NODE is absent", async () => {
    // The quote in the directory name proves the shim quotes the baked path.
    const runtimeDir = path.join(home, "run'time");
    await mkdir(runtimeDir, { recursive: true });
    const runtime = path.join(runtimeDir, "node");
    await writeFile(runtime, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {
      mode: 0o755,
    });
    await chmod(runtime, 0o755);

    await installSelf({
      packageRoot,
      homeDir: home,
      env,
      devHome,
      execPath: runtime,
      force: false,
    });

    const log = path.join(home, "baked.log");
    await run("/bin/sh", [shimPath(home), "whoami"], {
      env: {
        HOME: home,
        DEV_REVIEW_HOME: devHome,
        PATH: path.join(home, "no-node"),
        TRACE_TEST_LOG: log,
      },
    });
    expect(await readFile(log, "utf8")).toBe("whoami\n");
  });

  it("reports the install state", async () => {
    const before = await selfInstallStatus({
      homeDir: home,
      env,
      devHome,
      ownCliPath: "/x/cli.js",
      runningVersion: "0.1.0",
    });

    expect(before.installed).toBe(false);
    expect(before.runtimePath).toBe(null);
    expect(before.lines).toEqual([
      "Install: not installed (running from /x/cli.js)\n",
      `Command: ${shimPath(home)} (on PATH: no)\n`,
    ]);

    await install();

    const after = await selfInstallStatus({
      homeDir: home,
      env: {
        ...env,
        PATH: `${path.join(home, ".local", "bin")}:/usr/bin`,
        TRACE_DISABLE: "1",
      },
      devHome,
      ownCliPath: "/x/cli.js",
      runningVersion: "0.1.0",
    });

    expect(after).toMatchObject({
      installed: true,
      installedVersion: "0.1.0",
      runtimePath: process.execPath,
    });
    expect(after.shim).toMatchObject({
      present: true,
      owned: true,
      onPath: true,
    });
    expect(after.lines).toEqual([
      `Install: dev-traces 0.1.0 at ${currentLink(devHome)} (running 0.1.0)\n`,
      `Command: ${shimPath(home)} (on PATH: yes)\n`,
      `Runtime: ${process.execPath}\n`,
      "TRACE_DISABLE=1 is set; hooks are inert\n",
    ]);
  });
});
