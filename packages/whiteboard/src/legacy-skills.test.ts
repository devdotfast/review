import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeLegacySkills, scanLegacySkills } from "./legacy-skills";

const STAMPED = `---
name: dev-review
description: x
metadata:
  review-managed-by: "Review Desktop"
  review-generated: "Do not edit."
  review-version: "1.2.3"
---
# body
`;

const USER_OWNED = `---
name: review
description: my own review skill that wraps dev.fast Review
---
# body
`;

let homeDir: string;

let lockedFile: string | undefined;

afterEach(async () => {
  if (lockedFile) await chmod(lockedFile, 0o644);
  lockedFile = undefined;
  await rm(homeDir, { recursive: true, force: true });
});

async function skill(root: string, name: string, content: string) {
  await mkdir(path.join(homeDir, root, name), { recursive: true });
  await writeFile(path.join(homeDir, root, name, "SKILL.md"), content);
}

describe("scanLegacySkills", () => {
  it("lists only Review-stamped skills across the four roots", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
    await skill(".claude/skills", "dev-review", STAMPED);
    await skill(".agents/skills", "trace-archaeology", STAMPED);
    await skill(".claude/skills", "review", USER_OWNED);
    await skill(".claude/skills", "unrelated", STAMPED);

    expect(await scanLegacySkills(homeDir)).toEqual([
      path.join(homeDir, ".agents/skills/trace-archaeology"),
      path.join(homeDir, ".claude/skills/dev-review"),
    ]);
  });

  it("ignores a symlinked SKILL.md", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
    await mkdir(path.join(homeDir, ".claude/skills/scratchpad"), {
      recursive: true,
    });
    await writeFile(path.join(homeDir, "real.md"), STAMPED);
    await symlink(
      path.join(homeDir, "real.md"),
      path.join(homeDir, ".claude/skills/scratchpad/SKILL.md"),
    );

    expect(await scanLegacySkills(homeDir)).toEqual([]);
  });

  it("ignores a symlinked skill directory and leaves its target", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
    await skill("shared", "dev-review", STAMPED);
    await mkdir(path.join(homeDir, ".claude/skills"), { recursive: true });
    await symlink(
      path.join(homeDir, "shared/dev-review"),
      path.join(homeDir, ".claude/skills/dev-review"),
    );

    expect(await scanLegacySkills(homeDir)).toEqual([]);
    expect((await removeLegacySkills(homeDir)).removed).toEqual([]);
    await expect(
      lstat(path.join(homeDir, "shared/dev-review/SKILL.md")),
    ).resolves.toBeDefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    "skips a stamped skill whose SKILL.md cannot be read (root reads any file)",
    async () => {
      homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
      await skill(".claude/skills", "dev-review", STAMPED);
      lockedFile = path.join(homeDir, ".claude/skills/dev-review/SKILL.md");
      await chmod(lockedFile, 0o000);

      await expect(scanLegacySkills(homeDir)).resolves.toEqual([]);
      expect((await removeLegacySkills(homeDir)).removed).toEqual([]);
      await expect(lstat(lockedFile)).resolves.toBeDefined();
    },
  );

  it("lists and removes the old OpenCode plugin file, not a user's", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
    const plugins = path.join(homeDir, ".config/opencode/plugins");
    await mkdir(plugins, { recursive: true });
    await writeFile(
      path.join(plugins, "review.ts"),
      "// Managed by Review Desktop (@dev.fast/review).\nexport default {};\n",
    );
    await writeFile(path.join(plugins, "other.ts"), "// mine\n");

    expect(await scanLegacySkills(homeDir)).toEqual([
      path.join(plugins, "review.ts"),
    ]);
    await removeLegacySkills(homeDir);
    expect(await scanLegacySkills(homeDir)).toEqual([]);
    await expect(lstat(path.join(plugins, "other.ts"))).resolves.toBeDefined();
  });

  it("returns nothing when no roots exist", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
    expect(await scanLegacySkills(homeDir)).toEqual([]);
  });
});

describe("removeLegacySkills", () => {
  it("deletes stamped skills and leaves the user's", async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "legacy-skills-"));
    await skill(".claude/skills", "dev-review", STAMPED);
    await skill(".claude/skills", "review", USER_OWNED);

    const result = await removeLegacySkills(homeDir);

    expect(result.removed).toEqual([
      path.join(homeDir, ".claude/skills/dev-review"),
    ]);
    expect(await scanLegacySkills(homeDir)).toEqual([]);
    await expect(
      import("node:fs/promises").then((fs) =>
        fs.access(path.join(homeDir, ".claude/skills/review/SKILL.md")),
      ),
    ).resolves.toBeUndefined();
  });
});
