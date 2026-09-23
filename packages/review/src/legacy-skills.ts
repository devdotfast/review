import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { valid as validVersion } from "semver";

export const LEGACY_SKILL_NAMES = [
  "whiteboard",
  "dev-review",
  "dev-review-batch",
  "dev-file-lenses",
  "scratchpad",
  "trace-archaeology",
  "dev-review-map",
  "review",
  "review-map",
  "review-stop",
  "progressive-review",
  "pr-review",
] as const;

export function legacySkillRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, ".claude", "skills"),
    path.join(homeDir, ".cursor", "skills"),
    path.join(homeDir, ".config", "opencode", "skills"),
    path.join(homeDir, ".agents", "skills"),
  ];
}

/**
 * True only for a real skill directory (never a symlink to someone else's)
 * holding a regular SKILL.md whose frontmatter Review Desktop wrote.
 */
async function isReviewStamped(skillDir: string): Promise<boolean> {
  const file = path.join(skillDir, "SKILL.md");

  try {
    if (!(await lstat(skillDir)).isDirectory()) return false;

    if (!(await lstat(file)).isFile()) return false;
  } catch {
    return false;
  }

  const source = await readTextOrUndefined(file);

  // An unreadable file cannot be verified as Review's, so it is never removed.
  if (source === undefined) return false;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];

  const metadata = frontmatter?.match(
    /^metadata:\r?\n((?:[ \t]+[^\n]*(?:\n|$))*)/m,
  )?.[1];

  if (
    !metadata ||
    !(
      (/^  review-managed-by: "Review Desktop"\r?$/m.test(metadata) &&
        /^  review-generated: "[^"\r\n]+"\r?$/m.test(metadata)) ||
      (/^  whiteboard-managed-by: "Whiteboard(?: Desktop)?"\r?$/m.test(
        metadata,
      ) &&
        /^  whiteboard-generated: "[^"\r\n]+"\r?$/m.test(metadata))
    )
  )
    return false;

  const version = metadata.match(
    /^  (?:review|whiteboard)-version: "([^"\r\n]+)"\r?$/m,
  )?.[1];

  return (
    version !== undefined &&
    (version === "development" || validVersion(version) !== null)
  );
}

const OPENCODE_PLUGIN_MARKER =
  "// Managed by Review Desktop (@dev.fast/review).";

/** The OpenCode plugin file Review Desktop wrote before it connected over MCP. */
async function isLegacyOpenCodePlugin(file: string): Promise<boolean> {
  try {
    if (!(await lstat(file)).isFile()) return false;
  } catch {
    return false;
  }

  const source = await readTextOrUndefined(file);

  return source?.split(/\r?\n/, 1)[0] === OPENCODE_PLUGIN_MARKER;
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function scanLegacySkills(homeDir: string): Promise<string[]> {
  const found: string[] = [];

  for (const name of ["review.ts", "whiteboard.ts"]) {
    const plugin = path.join(homeDir, ".config", "opencode", "plugins", name);

    if (await isLegacyOpenCodePlugin(plugin)) found.push(plugin);
  }

  for (const root of legacySkillRoots(homeDir)) {
    for (const name of LEGACY_SKILL_NAMES) {
      const skillDir = path.join(root, name);

      if (await isReviewStamped(skillDir)) found.push(skillDir);
    }
  }

  return found.sort();
}

export async function removeLegacySkills(
  homeDir: string,
): Promise<{ removed: string[] }> {
  const removed: string[] = [];

  for (const skillDir of await scanLegacySkills(homeDir)) {
    await rm(skillDir, { recursive: true, force: true });
    removed.push(skillDir);
  }

  return { removed };
}
