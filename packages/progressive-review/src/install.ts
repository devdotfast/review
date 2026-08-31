import {
  copyFile,
  cp,
  lstat,
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

import { installFffForTargets, isFffTarget } from "./agent-fff";
import {
  installClaudeTraceHook,
  installCodexTraceHook,
  installPiTraceExtension,
} from "./agent-trace-hooks";
import { emitJsonEvent, failWithJsonError, humanStream } from "./cli-output";
import {
  type TraceCredentialsInput,
  configureTraceMachine,
  traceMachineEnabled,
} from "./trace-machine-setup";

export type InstallTarget = "claude" | "codex" | "cursor" | "opencode" | "pi";

const REQUIRED_SKILL_NAMES = ["dev-review", "dev-review-map"] as const;
// Installed only on machines that capture traces; removed when capture is
// disabled so agents are not steered toward an unconfigured feature.
const TRACE_SKILL_NAMES = ["trace-archaeology"] as const;
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
  "opencode",
  "pi",
];

type InstalledItem = { kind: "skill" | "extension" | "tool"; dest: string };

const OPENCODE_TOOL_NAME = "review.ts";
const OPENCODE_TOOL_MARKER = "Managed by Review Desktop (@dev.fast/review).";

export function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function runInstall(input: {
  targets: InstallTarget[];
  cwd?: string;
  homeDir?: string;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  fff?: boolean;
  reviewCommand?: string;
  trace?: {
    credentials?: TraceCredentialsInput;
    verify?: boolean;
  };
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): Promise<number> {
  const homeDir = input.homeDir ?? os.homedir();
  const packageRoot = input.packageRoot ?? defaultPackageRoot();
  const env = input.env ?? process.env;
  const human = humanStream(input);
  let traceEnabled = false;

  const skillsDir = path.join(packageRoot, "skills");
  const skillDirs = await listSkillDirs(skillsDir);
  const skillNames = new Set(skillDirs.map((skill) => skill.name));
  const missingSkills = [...REQUIRED_SKILL_NAMES, ...TRACE_SKILL_NAMES].filter(
    (name) => !skillNames.has(name),
  );
  if (missingSkills.length > 0) {
    return failWithJsonError(
      input,
      "install",
      `Bundled skills not found in ${skillsDir}: ${missingSkills.join(", ")}.`,
    );
  }
  const openCodeToolSource = path.join(
    packageRoot,
    "tools",
    OPENCODE_TOOL_NAME,
  );
  if (
    input.targets.includes("opencode") &&
    !(await isFile(openCodeToolSource))
  ) {
    return failWithJsonError(
      input,
      "install",
      `Bundled OpenCode tool not found: ${openCodeToolSource}.`,
    );
  }
  if (
    input.targets.includes("opencode") &&
    (await openCodeToolState(openCodeToolPath(homeDir))) === "unmanaged"
  ) {
    return failWithJsonError(
      input,
      "install",
      `${openCodeToolPath(homeDir)} already exists and is not managed by Review.`,
    );
  }

  // Check machine trace configuration before any per-agent mutation. A
  // headless install with missing credentials must fail without a partial
  // skills or FFF install.
  if (input.trace) {
    try {
      const status = await configureTraceMachine({
        homeDir,
        env,
        credentials: input.trace.credentials,
        verify: input.trace.verify,
      });
      traceEnabled = status.enabled;
      human.write(`[ok] trace capture -> ${status.envPath}\n`);
      if (status.error) {
        human.write(`Trace storage check failed: ${status.error}\n`);
      }
    } catch (cause) {
      return failWithJsonError(
        input,
        "install",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  // Agent hooks only make sense when this machine captures traces. A
  // previous install may already have enabled it without credentials in
  // this request.
  const installTraceHooks =
    traceEnabled || (await traceMachineEnabled({ homeDir, env }));

  const installed: InstalledItem[] = [];
  for (const target of input.targets) {
    const destRoot = skillsDestRoot(homeDir, target);
    await removeStaleSkills(destRoot);
    for (const skillDir of skillDirs) {
      const skillDest = path.join(destRoot, skillDir.name);
      if (
        isTraceSkill(skillDir.name) &&
        (!installTraceHooks || target === "opencode")
      ) {
        await rm(skillDest, { recursive: true, force: true });
        continue;
      }
      await installDirectory(skillDir.src, skillDest);
      installed.push({ kind: "skill", dest: skillDest });
    }
    if (target === "opencode") {
      const toolDest = openCodeToolPath(homeDir);
      await installFile(openCodeToolSource, toolDest);
      installed.push({ kind: "tool", dest: toolDest });
    }
    if (!installTraceHooks) continue;
    if (target === "claude") {
      await installClaudeTraceHook(homeDir, input.reviewCommand);
    } else if (target === "codex") {
      await installCodexTraceHook(homeDir, input.reviewCommand);
    } else if (target === "pi") {
      await installPiTraceExtension(homeDir, input.reviewCommand);
    }
  }

  if (input.fff) {
    const result = await installFffForTargets({
      targets: input.targets.filter(isFffTarget),
      homeDir,
      env,
      write: (text) => human.write(text),
    });
    if (!result.ok) {
      return failWithJsonError(
        input,
        "install",
        "Could not install the selected FFF integrations.",
      );
    }
    installed.push(
      ...result.created.map((registration) => ({
        kind: "extension" as const,
        dest: `${registration.target}:fff`,
      })),
    );
  }

  for (const item of installed) {
    human.write(`[ok] ${item.kind} -> ${item.dest}\n`);
  }
  // Best-effort per-repo git-notes setup: notes.rewriteRef so git-native
  // rebases/amends carry map notes, and the selected remote's fetch refspec so
  // ordinary fetches receive teammates' notes. Never fails the install.
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
  const installedSkillNames = [
    ...new Set(
      installed
        .filter((item) => item.kind === "skill")
        .map((item) => path.basename(item.dest)),
    ),
  ];
  const installedSkills = installedSkillNames.join(", ");
  if (input.targets.length > 0) {
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
  }
  emitJsonEvent(input, {
    event: "installed",
    targets: input.targets,
    skills: installedSkillNames,
    items: installed,
    gitNotesConfigured,
    traceEnabled,
  });
  return 0;
}

/** Removes the app-managed Review skills (current and stale names) for one agent. */
export async function removeInstalledSkills(
  target: InstallTarget,
  homeDir = os.homedir(),
): Promise<void> {
  const destRoot = skillsDestRoot(homeDir, target);
  for (const name of [
    ...REQUIRED_SKILL_NAMES,
    ...TRACE_SKILL_NAMES,
    ...STALE_SKILL_NAMES,
  ]) {
    await rm(path.join(destRoot, name), { recursive: true, force: true });
  }
  if (
    target === "opencode" &&
    (await openCodeToolState(openCodeToolPath(homeDir))) === "managed"
  ) {
    await rm(openCodeToolPath(homeDir), { force: true });
  }
}

export async function removeTraceSkills(
  target: InstallTarget,
  homeDir = os.homedir(),
): Promise<void> {
  const destRoot = skillsDestRoot(homeDir, target);
  for (const name of TRACE_SKILL_NAMES) {
    await rm(path.join(destRoot, name), { recursive: true, force: true });
  }
}

function isTraceSkill(name: string): boolean {
  return (TRACE_SKILL_NAMES as readonly string[]).includes(name);
}

export async function detectInstalledTargets(
  homeDir = os.homedir(),
): Promise<InstallTarget[]> {
  const knownSkillNames = [
    ...REQUIRED_SKILL_NAMES,
    ...TRACE_SKILL_NAMES,
    ...STALE_SKILL_NAMES,
  ];
  const installed: InstallTarget[] = [];
  for (const target of ALL_INSTALL_TARGETS) {
    const destRoot = skillsDestRoot(homeDir, target);
    if (target === "opencode") {
      const skillsPresent = await Promise.all(
        REQUIRED_SKILL_NAMES.map((name) =>
          hasValidSkillFile(path.join(destRoot, name, "SKILL.md"), name),
        ),
      );
      if (
        skillsPresent.every(Boolean) &&
        (await openCodeToolState(openCodeToolPath(homeDir))) === "managed"
      ) {
        installed.push(target);
      }
      continue;
    }
    const found = await Promise.all(
      knownSkillNames.map((name) => isDirectory(path.join(destRoot, name))),
    );
    if (found.some(Boolean)) {
      installed.push(target);
    }
  }
  return installed;
}

function skillsDestRoot(homeDir: string, target: InstallTarget): string {
  if (target === "claude") return path.join(homeDir, ".claude", "skills");
  if (target === "cursor") return path.join(homeDir, ".cursor", "skills");
  if (target === "opencode") {
    return path.join(homeDir, ".config", "opencode", "skills");
  }
  if (target === "pi") return path.join(homeDir, ".agents", "skills");
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
  await installPath(src, dest, (from, to) => cp(from, to, { recursive: true }));
}

async function installFile(src: string, dest: string): Promise<void> {
  await installPath(src, dest, copyFile);
}

async function installPath(
  src: string,
  dest: string,
  copy: (src: string, dest: string) => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  // Stage into a sibling temp path, then swap into place with renames so an
  // interruption mid-install never leaves the user with a half-removed skill
  // or tool. The temp paths are siblings of dest, so the renames stay on one
  // filesystem.
  const staging = `${dest}.tmp-${process.pid}`;
  const backup = `${dest}.bak-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await copy(src, staging);
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

function openCodeToolPath(homeDir: string): string {
  return path.join(homeDir, ".config", "opencode", "tools", OPENCODE_TOOL_NAME);
}

async function openCodeToolState(
  filePath: string,
): Promise<"managed" | "missing" | "unmanaged"> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "unmanaged";
    return (await readFile(filePath, "utf8")).includes(OPENCODE_TOOL_MARKER)
      ? "managed"
      : "unmanaged";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
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

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
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
