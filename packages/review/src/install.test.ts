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
import os from "node:os";
import path from "node:path";

import { collectingWritable } from "@dev.fast/trace-core";
import { afterEach, describe, expect, it } from "vitest";

import { installFile, runInstall } from "./install";

const ALL_SKILLS = ["dev-review"] as const;

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
  contents = `---\nname: ${name}\ndescription: ${name}\n---\n\n# ${name}\n`,
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
    path.join(packageRoot, "plugins", "review.ts"),
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
  it("removes only owned legacy skills and keeps the Pi pointer", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();

    for (const [root, name] of [
      [".claude", "dev-review"],
      [".claude", "trace-archaeology"],
      [".cursor", "scratchpad"],
      [".agents", "dev-review-batch"],
    ]) {
      await writeSkill(
        path.join(homeDir, root),
        name,
        `---\nname: ${name}\ndescription: managed\nmetadata:\n  review-managed-by: "Review Desktop"\n  review-generated: "generated"\n  review-version: "1.0.0"\n---\n`,
      );
    }

    await writeSkill(path.join(homeDir, ".claude"), "my-own");
    await mkdir(path.join(homeDir, ".claude/skills/review"), {
      recursive: true,
    });
    const streams = silentStreams();
    expect(
      await runInstall({
        targets: ["claude", "codex", "cursor", "pi"],
        homeDir,
        packageRoot,
        ...streams,
      }),
    ).toBe(0);

    for (const relative of [
      ".claude/skills/dev-review",
      ".claude/skills/trace-archaeology",
      ".cursor/skills/scratchpad",
      ".agents/skills/dev-review-batch",
    ])
      expect(existsSync(path.join(homeDir, relative))).toBe(false);

    for (const relative of [
      ".agents/skills/dev-review/SKILL.md",
      ".claude/skills/my-own",
      ".claude/skills/review",
    ])
      expect(existsSync(path.join(homeDir, relative))).toBe(true);
    expect(streams.out.join("")).toContain("not created by Review");
  });

  it("removes unstamped copies from older Review releases but not look-alikes", async () => {
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
    await writeSkill(claude, "review");
    await mkdir(path.join(homeDir, "elsewhere"), { recursive: true });
    await writeSkill(
      path.join(homeDir, "elsewhere"),
      "scratchpad",
      "---\nname: scratchpad\ndescription: x\n---\n\n# dev.fast Review\n",
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

  it("does not require a skill bundle or create skills roots for MCP targets", async () => {
    const packageRoot = await makePackageRoot();
    await rm(path.join(packageRoot, "skills"), { recursive: true });
    const homeDir = await makeTempDir();
    expect(
      await runInstall({
        targets: ["claude", "codex", "cursor", "opencode"],
        homeDir,
        packageRoot,
        ...silentStreams(),
      }),
    ).toBe(0);

    for (const root of [".claude", ".agents", ".cursor", ".config/opencode"])
      expect(existsSync(path.join(homeDir, root, "skills"))).toBe(false);
    expect(
      existsSync(path.join(homeDir, ".config/opencode/plugins/review.ts")),
    ).toBe(true);
  });

  it("replaces an installed-file symlink without changing its target", async () => {
    const packageRoot = await makePackageRoot();
    const source = path.join(packageRoot, "plugins", "review.ts");
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

  it("installs bundled Review documentation with the dev-review skill", async () => {
    const packageRoot = await makePackageRoot();
    const sourceDocs = path.join(packageRoot, "skills", "dev-review", "docs");
    await mkdir(path.join(sourceDocs, "assets"), { recursive: true });
    await writeFile(path.join(sourceDocs, "README.md"), "# Review docs\n");
    await writeFile(path.join(sourceDocs, "assets", "image.png"), "image\n");

    const homeDir = await makeTempDir();

    const destination = path.join(
      homeDir,
      ".agents",
      "skills",
      "dev-review",
      "docs",
    );

    await mkdir(destination, { recursive: true });
    await writeFile(
      path.join(path.dirname(destination), "SKILL.md"),
      '---\nname: dev-review\ndescription: managed\nmetadata:\n  review-managed-by: "Review Desktop"\n  review-generated: "generated"\n  review-version: "1.0.0"\n---\n',
    );
    await writeFile(path.join(destination, "stale.md"), "stale\n");
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["pi"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    expect(await readFile(path.join(destination, "README.md"), "utf8")).toBe(
      "# Review docs\n",
    );
    expect(
      await readFile(path.join(destination, "assets", "image.png"), "utf8"),
    ).toBe("image\n");
    await expect(
      readFile(path.join(destination, "stale.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("installs trace hooks once capture is enabled", async () => {
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
    const skillDest = path.join(homeDir, ".agents", "skills", "dev-review");
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
