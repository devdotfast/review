import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const registrySchema = z.object({
  versions: z.record(z.string(), z.object({ gitHead: z.string().optional() })),
});

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const packageName = "@dev.fast/whiteboard";

export function parseVersion(version) {
  if (!stable.test(version))
    throw new Error(`Expected a stable X.Y.Z version, got ${version}`);
  const parts = version.split(".").map(Number);

  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error("Version component is too large");

  return parts;
}

export function nextVersion(versions, bump) {
  const index = ["major", "minor", "patch"].indexOf(bump);

  if (index < 0) throw new Error(`Invalid version bump: ${bump}`);

  const sorted = versions
    .filter((v) => stable.test(v))
    .map(parseVersion)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const parts = sorted.at(-1) ?? [0, 0, 0];
  parts[index] += 1;

  for (let i = index + 1; i < 3; i++) parts[i] = 0;
  const result = parts.join(".");
  parseVersion(result);

  return result;
}

export async function registryMetadata(send = fetch) {
  const response = await send(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    { signal: AbortSignal.timeout(30_000) },
  );

  if (response.status === 404) return { versions: {} };

  if (!response.ok)
    throw new Error(
      `npm registry lookup failed (${response.status}); refusing to guess a version`,
    );
  const parsed = registrySchema.safeParse(await response.json());

  if (!parsed.success) throw new Error("Invalid npm registry metadata");

  return parsed.data;
}

/** Existing versions are immutable; a rerun may only accept this source commit. */
export function alreadyPublished(metadata, version, commit) {
  const published = metadata.versions[version];

  if (!published) return false;

  if (published.gitHead !== commit)
    throw new Error(
      `${packageName}@${version} already exists from another or unknown commit. Choose a new version.`,
    );

  return true;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export async function resolveRelease(env = process.env, send = fetch) {
  const commit = git("rev-parse", "HEAD");
  // This fetch is read-only. The release is always the triggering SHA, never a moving branch tip.
  git("fetch", "origin", "main", "--tags");
  git("merge-base", "--is-ancestor", commit, "origin/main");
  const metadata = await registryMetadata(send);
  let tag;

  if (env.GITHUB_EVENT_NAME === "push") {
    tag = env.GITHUB_REF_NAME;
  } else if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    if (env.GITHUB_REF !== "refs/heads/main")
      throw new Error("Run CLI releases from main.");

    if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? ""))
      throw new Error("Missing workflow run ID");
    const marker = `Whiteboard CLI release run ${env.GITHUB_RUN_ID}`;

    const existing = git(
      "for-each-ref",
      "--format=%(refname:short)|%(contents:subject)",
      "refs/tags/whiteboard-v*",
    )
      .split("\n")
      .filter((line) => line.endsWith(`|${marker}`));

    if (existing.length > 1)
      throw new Error("Multiple tags belong to this release run");

    if (existing.length) tag = existing[0].split("|")[0];
    else {
      const tags = git("tag", "--list", "whiteboard-v*")
        .split("\n")
        .map((value) => value.slice("whiteboard-v".length));

      const pkg = JSON.parse(
        readFileSync("packages/whiteboard/package.json", "utf8"),
      );

      tag = `whiteboard-v${nextVersion([...Object.keys(metadata.versions), ...tags, pkg.version], env.RELEASE_BUMP)}`;
    }
  } else
    throw new Error("Use workflow_dispatch or a whiteboard-vX.Y.Z tag push");

  if (!tag?.startsWith("whiteboard-v"))
    throw new Error("Expected a whiteboard-vX.Y.Z tag");
  const version = tag.slice("whiteboard-v".length);
  parseVersion(version);
  const exists = git("tag", "--list", tag) === tag;

  if (exists && git("rev-parse", `${tag}^{commit}`) !== commit)
    throw new Error(`${tag} points to a different commit`);
  const published = alreadyPublished(metadata, version, commit);

  // Never move npm's latest dist-tag backwards with a historical tag.
  if (
    !published &&
    nextVersion([version, ...Object.keys(metadata.versions)], "patch") !==
      nextVersion([version], "patch")
  )
    throw new Error(
      "Release version must be newer than every published stable version",
    );
  const plan = { version, tag, commit, published, runId: env.GITHUB_RUN_ID };
  writeFileSync("release-plan.json", `${JSON.stringify(plan, null, 2)}\n`);

  if (env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(plan))
      appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(
    `${packageName}@${version} from ${commit}${published ? " (already published)" : ""}`,
  );

  return plan;
}

export function createTag(plan) {
  parseVersion(plan.version);

  if (plan.tag !== `whiteboard-v${plan.version}`)
    throw new Error("Tag/version mismatch");

  const existing = git(
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${plan.tag}`,
    `refs/tags/${plan.tag}^{}`,
  );

  if (existing) {
    const lines = existing.split("\n");

    const sha = (lines.find((line) => line.endsWith("^{}")) ?? lines[0]).split(
      /\s/,
    )[0];

    if (sha !== plan.commit)
      throw new Error(`${plan.tag} already points to a different commit`);

    return;
  }

  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "tag",
    "-a",
    plan.tag,
    plan.commit,
    "-m",
    `Whiteboard CLI release run ${plan.runId}`,
  );
  git("push", "origin", `refs/tags/${plan.tag}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];

  if (mode === "plan") await resolveRelease();
  else if (mode === "tag")
    createTag(JSON.parse(readFileSync("release-plan.json", "utf8")));
  else throw new Error("Usage: whiteboard-cli-release.mjs plan|tag");
}
