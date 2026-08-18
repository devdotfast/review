import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureNotesConfig, gitCommonDir } from "@dev.fast/local-vcs";

import { emitJsonEvent, failWithJsonError, humanStream } from "./cli-output";

export type InstallTarget = "claude" | "codex" | "cursor";

const REQUIRED_SKILL_NAMES = ["dev-review", "dev-review-map"] as const;
const STALE_SKILL_NAMES = [
  "review",
  "review-map",
  "review-stop",
  "progressive-review",
  "pr-review",
] as const;
export const ALL_INSTALL_TARGETS: InstallTarget[] = [
  "claude",
  "codex",
  "cursor",
];

type InstalledItem = { kind: "skill"; dest: string };

export function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function runInstall(input: {
  targets: InstallTarget[];
  cwd?: string;
  homeDir?: string;
  packageRoot?: string;
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  const homeDir = input.homeDir ?? os.homedir();
  const packageRoot = input.packageRoot ?? defaultPackageRoot();
  const human = humanStream(input);

  const skillsDir = path.join(packageRoot, "skills");
  const skillDirs = await listSkillDirs(skillsDir);
  const skillNames = new Set(skillDirs.map((skill) => skill.name));
  const missingSkills = REQUIRED_SKILL_NAMES.filter(
    (name) => !skillNames.has(name),
  );
  if (missingSkills.length > 0) {
    return failWithJsonError(
      input,
      "install",
      `Bundled skills not found in ${skillsDir}: ${missingSkills.join(", ")}.`,
    );
  }

  const installed: InstalledItem[] = [];
  for (const target of input.targets) {
    const destRoot = skillsDestRoot(homeDir, target);
    await removeStaleSkills(destRoot);
    for (const skillDir of skillDirs) {
      const skillDest = path.join(destRoot, skillDir.name);
      await installDirectory(skillDir.src, skillDest);
      installed.push({ kind: "skill", dest: skillDest });
    }
  }

  for (const item of installed) {
    human.write(`[ok] ${item.kind} -> ${item.dest}\n`);
  }
  // Best-effort per-repo git-notes setup: notes.rewriteRef so git-native
  // rebases/amends carry map notes, and the origin fetch refspec so ordinary
  // fetches receive teammates' notes. Never fails the install.
  let gitNotesConfigured = false;
  if (input.cwd) {
    try {
      const gitDir = await gitCommonDir(input.cwd);
      if (gitDir) {
        await ensureNotesConfig({ rootPath: input.cwd });
        gitNotesConfigured = true;
        human.write(`[ok] git notes config -> ${gitDir}\n`);
      }
    } catch {
      // Repos without git (or without permissions) simply skip notes config.
    }
  }
  const installedSkills = skillDirs.map((skill) => skill.name).join(", ");
  human.write(
    `\nInstalled Review skills for ${formatTargets(input.targets)}: ${installedSkills}.\n` +
      (input.targets.includes("codex")
        ? "In Codex, invoke via /skills or the installed dev-review skill.\n"
        : "") +
      (input.targets.includes("cursor")
        ? "In Cursor, invoke the skills from the / menu (for example /dev-review).\n"
        : "") +
      "Restart the agent (or open a new session) to pick up the changes.\n",
  );
  emitJsonEvent(input, {
    event: "installed",
    targets: input.targets,
    skills: skillDirs.map((skill) => skill.name),
    items: installed,
    gitNotesConfigured,
  });
  return 0;
}

/** Removes the app-managed Review skills (current and stale names) for one agent. */
export async function removeInstalledSkills(
  target: InstallTarget,
  homeDir = os.homedir(),
): Promise<void> {
  const destRoot = skillsDestRoot(homeDir, target);
  for (const name of [...REQUIRED_SKILL_NAMES, ...STALE_SKILL_NAMES]) {
    await rm(path.join(destRoot, name), { recursive: true, force: true });
  }
}

export async function detectInstalledTargets(
  homeDir = os.homedir(),
): Promise<InstallTarget[]> {
  const knownSkillNames = [...REQUIRED_SKILL_NAMES, ...STALE_SKILL_NAMES];
  const installed: InstallTarget[] = [];
  for (const target of ALL_INSTALL_TARGETS) {
    const destRoot = skillsDestRoot(homeDir, target);
    const found = await Promise.all(
      knownSkillNames.map((name) => isDirectory(path.join(destRoot, name))),
    );
    if (found.some(Boolean)) installed.push(target);
  }
  return installed;
}

function skillsDestRoot(homeDir: string, target: InstallTarget): string {
  if (target === "claude") return path.join(homeDir, ".claude", "skills");
  if (target === "cursor") return path.join(homeDir, ".cursor", "skills");
  return path.join(homeDir, ".agents", "skills");
}

function formatTargets(targets: InstallTarget[]): string {
  if (targets.length <= 1) return targets.join("");
  return `${targets.slice(0, -1).join(", ")} and ${targets[targets.length - 1]}`;
}

async function listSkillDirs(
  skillsDir: string,
): Promise<{ name: string; src: string }[]> {
  if (!(await isDirectory(skillsDir))) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        name: entry.name,
        src: path.join(skillsDir, entry.name),
        hasSkillFile: await hasValidSkillFile(
          path.join(skillsDir, entry.name, "SKILL.md"),
          entry.name,
        ),
      })),
  );
  return skills
    .filter((entry) => entry.hasSkillFile)
    .map(({ name, src }) => ({ name, src }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function installDirectory(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  // Stage into a sibling temp dir, then swap into place with renames so an
  // interruption mid-install never leaves the user with a half-removed skill.
  // The temp dirs are siblings of dest, so the renames stay on one filesystem.
  const staging = `${dest}.tmp-${process.pid}`;
  const backup = `${dest}.bak-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(src, staging, { recursive: true });
  let movedExisting = false;
  try {
    await rename(dest, backup);
    movedExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, dest);
  } catch (error) {
    if (movedExisting) await rename(backup, dest).catch(() => {});
    throw error;
  }
  if (movedExisting) await rm(backup, { recursive: true, force: true });
}

async function removeStaleSkills(destRoot: string): Promise<void> {
  for (const skillName of STALE_SKILL_NAMES) {
    await rm(path.join(destRoot, skillName), { recursive: true, force: true });
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function hasValidSkillFile(
  target: string,
  expectedName: string,
): Promise<boolean> {
  try {
    if (!(await stat(target)).isFile()) return false;
    const source = await readFile(target, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
    if (!frontmatter) return false;
    const name = frontmatter.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1];
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1];
    return name === expectedName && !!description?.trim();
  } catch {
    return false;
  }
}
