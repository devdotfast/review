import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectingWritable,
  enableTraceRepository,
  traceRepositoryStatus,
  traceScope,
} from "@dev.fast/trace-core";
import { afterEach, describe, expect, it } from "vitest";

import { installFile, removeInstalledSkills, runInstall } from "./install";

const REQUIRED_SKILLS = ["whiteboard"] as const;

const ALL_SKILLS = [
  ...REQUIRED_SKILLS,
  "trace-archaeology",
  "scratchpad",
] as const;

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();

    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "review-install-"));
  tempRoots.push(dir);

  return dir;
}

async function writeSkill(
  packageRoot: string,
  name: string,
  contents = `---\nname: ${name}\ndescription: ${name}\nmetadata:\n  review-managed-by: "Review Desktop"\n  review-generated: "Managed test fixture"\n  review-version: "development"\n---\n\n# ${name}\n`,
): Promise<void> {
  const skillDir = path.join(packageRoot, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), contents);
}

async function makePackageRoot(): Promise<string> {
  const packageRoot = await makeTempDir();

  for (const name of ALL_SKILLS) {
    await writeSkill(packageRoot, name);
  }

  await mkdir(path.join(packageRoot, "plugins"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "plugins", "whiteboard.ts"),
    "// Managed by Review Desktop (@dev.fast/review).\n",
  );

  return packageRoot;
}

function silentStreams() {
  const out: string[] = [];
  const err: string[] = [];

  return {
    out,
    err,
    stdout: collectingWritable(out),
    stderr: collectingWritable(err),
  };
}

describe("runInstall", () => {
  it("replaces an installed-file symlink without changing its target", async () => {
    const packageRoot = await makePackageRoot();
    const source = path.join(packageRoot, "plugins", "whiteboard.ts");
    const destinationRoot = await makeTempDir();
    const external = path.join(await makeTempDir(), "external-plugin.ts");
    const pluginPath = path.join(destinationRoot, "plugins", "review.ts");
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await writeFile(external, "external\n");
    await symlink(external, pluginPath);

    await installFile(source, pluginPath);

    expect((await lstat(pluginPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(pluginPath, "utf8")).toContain(
      "Managed by Review Desktop",
    );
    expect(await readFile(external, "utf8")).toBe("external\n");
  });

  it("installs the Whiteboard skill only for Pi", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["claude", "codex", "cursor", "pi"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);

    for (const name of REQUIRED_SKILLS) {
      expect(
        await readFile(
          path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
    }
    await expect(
      readFile(path.join(homeDir, ".claude", "skills", "whiteboard", "SKILL.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(path.join(homeDir, ".cursor", "skills", "whiteboard", "SKILL.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);

    // Trace capture is off by default: no agent hooks, no trace skill.
    expect(existsSync(path.join(homeDir, ".claude", "settings.json"))).toBe(
      false,
    );
    expect(existsSync(path.join(homeDir, ".codex", "config.toml"))).toBe(false);
    expect(
      existsSync(path.join(homeDir, ".claude", "skills", "trace-archaeology")),
    ).toBe(false);

    // The scratchpad is off by default: no scratchpad skill either.
    expect(
      existsSync(path.join(homeDir, ".claude", "skills", "scratchpad")),
    ).toBe(false);

    // Legacy prompt/command locations should stay empty.
    await expect(
      readFile(
        path.join(homeDir, ".claude", "commands", "pr-review.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(path.join(homeDir, ".codex", "prompts", "pr-review.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".claude", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);

    for (const staleName of ["review-map", "review-stop"]) {
      await expect(
        readFile(
          path.join(homeDir, ".claude", "skills", staleName, "SKILL.md"),
          "utf8",
        ),
      ).rejects.toThrow(/ENOENT/);
      await expect(
        readFile(
          path.join(homeDir, ".agents", "skills", staleName, "SKILL.md"),
          "utf8",
        ),
      ).rejects.toThrow(/ENOENT/);
    }
  });

  it("does not install an agent skill for an MCP target", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["codex"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    await expect(
      readFile(
        path.join(homeDir, ".claude", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".claude", "commands", "pr-review.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".cursor", "skills", "dev-review", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);

    await expect(
      readFile(path.join(homeDir, ".agents", "skills", "whiteboard", "SKILL.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);

    await expect(
      readFile(
        path.join(homeDir, ".codex", "prompts", "review-stop.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".agents", "skills", "review-stop", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".agents", "skills", "review-map", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it("removes a retired skill only while Review still manages it", async () => {
    const packageRoot = await makePackageRoot();
    const managedHome = await makeTempDir();
    const editedHome = await makeTempDir();

    const retired = (homeDir: string) =>
      path.join(homeDir, ".claude", "skills", "dev-review-batch");

    const stamp =
      'metadata:\n  review-managed-by: "Review Desktop"\n  review-generated: "Do not edit."\n  review-version: "development"\n';

    for (const [homeDir, metadata] of [
      [managedHome, stamp],
      [editedHome, ""],
    ]) {
      await mkdir(retired(homeDir), { recursive: true });
      await writeFile(
        path.join(retired(homeDir), "SKILL.md"),
        `---\nname: dev-review-batch\ndescription: batch\n${metadata}---\n`,
      );
      const streams = silentStreams();

      expect(
        await runInstall({
          targets: ["claude"],
          homeDir,
          packageRoot,
          stdout: streams.stdout,
          stderr: streams.stderr,
        }),
      ).toBe(0);
    }

    expect(existsSync(retired(managedHome))).toBe(false);
    expect(existsSync(path.join(retired(editedHome), "SKILL.md"))).toBe(true);
  });

  it("removes recognizable unstamped Review skills but keeps look-alikes and symlinks", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const claude = path.join(homeDir, ".claude");

    await writeSkill(
      claude,
      "dev-review",
      "---\nname: dev-review\ndescription: old\n---\n\n# dev.fast Review\n",
    );
    await writeSkill(
      claude,
      "pr-review",
      "---\nname: pr-review\ndescription: old\n---\n\nInstall @dev.fast/review.\n",
    );
    await writeSkill(
      claude,
      "review",
      "---\nname: review\ndescription: unrelated\n---\n\nMy own skill.\n",
    );
    await mkdir(path.join(homeDir, "elsewhere"), { recursive: true });
    await writeSkill(
      path.join(homeDir, "elsewhere"),
      "scratchpad",
      "---\nname: scratchpad\ndescription: unrelated\n---\n\n# dev.fast Review\n",
    );
    await symlink(
      path.join(homeDir, "elsewhere/skills/scratchpad"),
      path.join(claude, "skills/scratchpad"),
    );

    expect(
      await runInstall({
        targets: ["claude"],
        homeDir,
        packageRoot,
        ...silentStreams(),
      }),
    ).toBe(0);

    for (const name of ["dev-review", "pr-review"])
      expect(existsSync(path.join(claude, "skills", name))).toBe(false);
    for (const name of ["review", "scratchpad"])
      expect(existsSync(path.join(claude, "skills", name))).toBe(true);
  });

  it("installs only Pi when requested", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["pi"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);

    for (const name of REQUIRED_SKILLS) {
      expect(
        await readFile(
          path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
    }

    expect(
      existsSync(
        path.join(homeDir, ".pi", "agent", "extensions", "review-trace.ts"),
      ),
    ).toBe(false);
  });

  it("installs trace hooks and the trace skill once capture is enabled", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const streams = silentStreams();
    const settingsPath = path.join(homeDir, "trace-settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        enabled: true,
        autoActivateRepositories: true,
      }),
    );

    const code = await runInstall({
      targets: ["claude", "codex", "pi"],
      homeDir,
      packageRoot,
      env: { TRACE_SETTINGS_FILE: settingsPath },
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);

    expect(existsSync(path.join(homeDir, ".claude", "settings.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(homeDir, ".codex", "config.toml"))).toBe(true);
    expect(
      existsSync(
        path.join(homeDir, ".pi", "agent", "extensions", "review-trace.ts"),
      ),
    ).toBe(true);
  });

  it("fails clearly when the bundled skill is missing", async () => {
    const packageRoot = await makeTempDir();
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["pi"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(1);
    expect(streams.err.join("")).toContain("Bundled skills not found");
  });

  it("keeps the previous skill install when staging the new one fails", async () => {
    const homeDir = await makeTempDir();
    const skillDest = path.join(homeDir, ".agents", "skills", "whiteboard");
    await mkdir(skillDest, { recursive: true });
    await writeFile(path.join(skillDest, "SKILL.md"), "# existing\n");

    // Point the skill source at a path that does not exist so the copy step
    // throws after the existing install is already in place.
    const brokenRoot = await makeTempDir();
    // skills/dev-review is intentionally absent -> isDirectory guard
    // returns 1 before touching the existing install.
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["pi"],
      homeDir,
      packageRoot: brokenRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(1);
    // The previously installed skill is untouched.
    expect(await readFile(path.join(skillDest, "SKILL.md"), "utf8")).toContain(
      "# existing",
    );
  });
});

it("refuses a canonical skill-name collision before replacing an existing legacy skill", async () => {
  const packageRoot = await makePackageRoot();
  const homeDir = await makeTempDir();
  const skills = path.join(homeDir, ".agents", "skills");
  const custom = path.join(skills, "whiteboard", "SKILL.md");
  const legacy = path.join(skills, "dev-review", "SKILL.md");
  await mkdir(path.dirname(custom), { recursive: true });
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(
    custom,
    "---\nname: whiteboard\ndescription: My drawing tool\n---\nKeep my instructions.",
  );
  await writeFile(legacy, "Existing installed skill");
  const streams = silentStreams();
  expect(
    await runInstall({
      packageRoot,
      homeDir,
      cwd: homeDir,
      targets: ["pi"],
      ...streams,
    }),
  ).toBe(1);
  expect(await readFile(custom, "utf8")).toContain("Keep my instructions.");
  expect(await readFile(legacy, "utf8")).toBe("Existing installed skill");
  expect(streams.err.join("")).toContain("not managed by Whiteboard");
  await removeInstalledSkills("codex", homeDir);
  expect(await readFile(custom, "utf8")).toContain("Keep my instructions.");
});

it.each([true, false])(
  "updates existing managed Git hooks only when tracing is enabled (%s)",
  async (enabled) => {
    const homeDir = await makeTempDir();
    const packageRoot = await makePackageRoot();
    const cwd = await makeTempDir();
    execFileSync("git", ["init", "--quiet", cwd]);
    const settingsPath = path.join(homeDir, "trace-settings.json");

    const settings = JSON.stringify({
      version: 1,
      enabled,
      autoActivateRepositories: true,
    });

    await writeFile(settingsPath, settings);
    const env = { TRACE_SETTINGS_FILE: settingsPath };
    const bin = path.join(homeDir, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const oldCommand = path.join(bin, "review");
    const command = path.join(bin, "whiteboard");
    const invoked = path.join(homeDir, "invoked");
    await writeFile(oldCommand, "#!/bin/sh\nexit 99\n");
    await writeFile(command, `#!/bin/sh\nprintf '%s\\n' "$@" > '${invoked}'\n`);
    await chmod(oldCommand, 0o755);
    await chmod(command, 0o755);
    const customHooks = path.join(cwd, "custom-hooks");
    await mkdir(customHooks);
    await writeFile(
      path.join(customHooks, "prepare-commit-msg"),
      "#!/bin/sh\nexit 0\n",
    );
    await chmod(path.join(customHooks, "prepare-commit-msg"), 0o755);
    execFileSync("git", ["-C", cwd, "config", "core.hooksPath", customHooks]);
    await enableTraceRepository({
      cwd,
      scope: traceScope({ homeDir, env }),
      whiteboardCommand: oldCommand,
    });
    const before = await traceRepositoryStatus(cwd);
    const streams = silentStreams();
    expect(
      await runInstall({
        targets: [],
        homeDir,
        packageRoot,
        env,
        whiteboardCommand: command,
        stdout: streams.stdout,
        stderr: streams.stderr,
      }),
    ).toBe(0);
    const after = await traceRepositoryStatus(cwd);
    expect(after.previousHooksPath).toBe(customHooks);
    expect(after.command).toContain(enabled ? command : oldCommand);
    expect(await readFile(settingsPath, "utf8")).toBe(settings);

    if (enabled) {
      execFileSync(
        "sh",
        [path.join(after.managedHooksPath!, "prepare-commit-msg"), "message"],
        { cwd },
      );
    }

    expect(existsSync(invoked)).toBe(enabled);
    expect(enabled ? await readFile(invoked, "utf8") : after).toEqual(
      enabled ? "trace\ngit-hook\nprepare-commit-msg\nmessage\n" : before,
    );
  },
);
