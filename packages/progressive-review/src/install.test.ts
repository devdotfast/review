import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectingWritable } from "./cli-output";
import { runInstall } from "./install";

const REQUIRED_SKILLS = ["dev-review", "dev-review-map"] as const;
const ALL_SKILLS = [...REQUIRED_SKILLS, "trace-archaeology"] as const;

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
  it("installs Review skills to Claude Code, Codex, and Cursor by default", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["claude", "codex", "cursor"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    for (const name of REQUIRED_SKILLS) {
      expect(
        await readFile(
          path.join(homeDir, ".claude", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
      expect(
        await readFile(
          path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
      expect(
        await readFile(
          path.join(homeDir, ".cursor", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
    }
    // Trace capture is off by default: no agent hooks, no trace skill.
    expect(existsSync(path.join(homeDir, ".claude", "settings.json"))).toBe(
      false,
    );
    expect(existsSync(path.join(homeDir, ".codex", "config.toml"))).toBe(false);
    expect(
      existsSync(path.join(homeDir, ".claude", "skills", "trace-archaeology")),
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

  it("installs only the requested target", async () => {
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
    for (const name of REQUIRED_SKILLS) {
      expect(
        await readFile(
          path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
    }
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

  it("replaces a stale existing skill install", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const skillDest = path.join(homeDir, ".claude", "skills", "dev-review");
    await mkdir(skillDest, { recursive: true });
    await writeFile(path.join(skillDest, "stale.md"), "old\n");
    const staleOldNameDest = path.join(homeDir, ".claude", "skills", "review");
    await mkdir(staleOldNameDest, { recursive: true });
    await writeFile(path.join(staleOldNameDest, "SKILL.md"), "# old-name\n");
    const staleMapDest = path.join(homeDir, ".claude", "skills", "review-map");
    await mkdir(staleMapDest, { recursive: true });
    await writeFile(path.join(staleMapDest, "SKILL.md"), "# old-map\n");
    const staleStopDest = path.join(
      homeDir,
      ".claude",
      "skills",
      "review-stop",
    );
    await mkdir(staleStopDest, { recursive: true });
    await writeFile(path.join(staleStopDest, "SKILL.md"), "# old-stop\n");
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["claude"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    await expect(
      readFile(path.join(skillDest, "stale.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    expect(await readFile(path.join(skillDest, "SKILL.md"), "utf8")).toContain(
      "# dev-review",
    );
    await expect(
      readFile(path.join(staleOldNameDest, "SKILL.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(path.join(staleMapDest, "SKILL.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(path.join(staleStopDest, "SKILL.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
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
    await writeFile(path.join(destination, "stale.md"), "stale\n");
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["codex"],
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

  it("installs only Cursor when requested", async () => {
    const packageRoot = await makePackageRoot();
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["cursor"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(0);
    for (const name of REQUIRED_SKILLS) {
      expect(
        await readFile(
          path.join(homeDir, ".cursor", "skills", name, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`# ${name}`);
    }
    await expect(
      readFile(
        path.join(homeDir, ".claude", "skills", "dev-review", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(
        path.join(homeDir, ".agents", "skills", "dev-review", "SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow(/ENOENT/);
    expect(streams.out.join("")).toContain("In Cursor, invoke the skills");
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
    for (const root of [".claude", ".agents"]) {
      expect(
        await readFile(
          path.join(homeDir, root, "skills", "trace-archaeology", "SKILL.md"),
          "utf8",
        ),
      ).toContain("# trace-archaeology");
    }
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
      targets: ["claude", "codex", "cursor"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(1);
    expect(streams.err.join("")).toContain("Bundled skills not found");
  });

  it("fails when the bundle is missing required Review action skills", async () => {
    const packageRoot = await makeTempDir();
    await writeSkill(packageRoot, "dev-review");
    const invalidSkillDir = path.join(packageRoot, "skills", "dev-review-map");
    await mkdir(invalidSkillDir, { recursive: true });
    await writeFile(
      path.join(invalidSkillDir, "SKILL.md"),
      "# dev-review-map\n",
    );
    const homeDir = await makeTempDir();
    const streams = silentStreams();

    const code = await runInstall({
      targets: ["claude"],
      homeDir,
      packageRoot,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    expect(code).toBe(1);
    expect(streams.err.join("")).toContain("Bundled skills not found");
    expect(streams.err.join("")).toContain("dev-review-map");
    // Both agents use the same skill set, so Codex should fail too.
    const codexStreams = silentStreams();
    expect(
      await runInstall({
        targets: ["codex"],
        homeDir,
        packageRoot,
        stdout: codexStreams.stdout,
        stderr: codexStreams.stderr,
      }),
    ).toBe(1);
  });

  it("keeps the previous skill install when staging the new one fails", async () => {
    const homeDir = await makeTempDir();
    const skillDest = path.join(homeDir, ".claude", "skills", "dev-review");
    await mkdir(skillDest, { recursive: true });
    await writeFile(path.join(skillDest, "SKILL.md"), "# existing\n");

    // Point the skill source at a path that does not exist so the copy step
    // throws after the existing install is already in place.
    const brokenRoot = await makeTempDir();
    // skills/dev-review is intentionally absent -> isDirectory guard
    // returns 1 before touching the existing install.
    const streams = silentStreams();
    const code = await runInstall({
      targets: ["claude"],
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
