import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseJsonText } from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import { createNativeTutorial } from "../src/server/tutorial-service";
import { sourceReferences } from "../src/session-api/document";
import { openLocalSessionStore } from "../src/session-api/local-data";

const execFilePromise = promisify(execFile);

const packageRoot = path.resolve(import.meta.dirname, "..");

const tutorialDir = path.join(packageRoot, "tutorial");

/** A manifest entry that names a file inside the tutorial tree. */
const safeManifestPathSchema = z
  .string()
  .min(1)
  .refine(
    (entry) => !path.isAbsolute(entry) && !entry.split(/[\\/]/u).includes(".."),
  );

export const tutorialRuntimeManifestSchema = z
  .object({
    version: z.literal(1),
    whiteboardFiles: z.array(safeManifestPathSchema).min(1),
    requiredPaths: z.array(safeManifestPathSchema).min(1),
  })
  .refine((manifest) =>
    manifest.whiteboardFiles.every((entry) =>
      manifest.requiredPaths.includes(entry),
    ),
  );

export async function readTutorialRuntimeManifest(
  tutorialRoot: string,
): Promise<z.infer<typeof tutorialRuntimeManifestSchema>> {
  const parsed = tutorialRuntimeManifestSchema.safeParse(
    parseJsonText(
      await readFile(path.join(tutorialRoot, "runtime-manifest.json"), "utf8"),
    ),
  );

  if (!parsed.success) {
    throw new Error("Tutorial runtime manifest is invalid.");
  }

  return parsed.data;
}

/* Source pins must be identical on every build machine. The native tutorial
   validates its evidence and both maps against these exact commits. */
const COMMIT_ENV = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  TZ: "UTC",
};

export interface BuiltTutorialAssets {
  baseCommit: string;
  commit: string;
  peekCount: number;
}

const BASE_SOURCE_REWRITES = [
  {
    path: "src/inventory/inventory-service.ts",
    head: `  reserve(items: readonly CheckoutItem[]): void {
    const unavailable = items.find((item) => item.quantity < 1);

    if (unavailable) {
      throw new Error(\`Invalid quantity for \${unavailable.sku}\`);
    }
  }`,
    base: "  reserve(_items: readonly CheckoutItem[]): void {}",
  },
  {
    path: "src/payments/payment-gateway.ts",
    head: `  charge(paymentToken: string, amountCents: number): PaymentReceipt {
    if (!paymentToken) throw new Error("A payment token is required");`,
    base: `  charge(_paymentToken: string, amountCents: number): PaymentReceipt {`,
  },
] as const;

export async function buildTutorialAssets(
  input: { outDir?: string } = {},
): Promise<BuiltTutorialAssets> {
  const outDir = input.outDir ?? tutorialDir;
  await readTutorialRuntimeManifest(tutorialDir);

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "review-tutorial-build-"),
  );

  try {
    // 1. Deterministic stub repository.
    const repo = path.join(temporaryRoot, "sample-service");
    await cp(path.join(tutorialDir, "sample-service"), repo, {
      recursive: true,
    });
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.name", "Review Tutorial"]);
    await git(repo, ["config", "user.email", "tutorial@review.local"]);
    const headSources = new Map<string, string>();

    for (const rewrite of BASE_SOURCE_REWRITES) {
      const sourcePath = path.join(repo, rewrite.path);
      const headSource = await readFile(sourcePath, "utf8");

      if (!headSource.includes(rewrite.head)) {
        throw new Error(`Tutorial base rewrite is stale for ${rewrite.path}.`);
      }

      headSources.set(rewrite.path, headSource);
      await writeFile(
        sourcePath,
        headSource.replace(rewrite.head, rewrite.base),
      );
    }

    await git(repo, ["add", "."]);
    await git(repo, [
      "commit",
      "--no-gpg-sign",
      "-m",
      "Create sample order service",
    ]);
    const baseCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();

    for (const [relativePath, source] of headSources) {
      await writeFile(path.join(repo, relativePath), source);
    }

    await git(repo, ["add", "."]);
    await git(repo, [
      "commit",
      "--no-gpg-sign",
      "-m",
      "Validate checkout inputs",
    ]);
    const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const count = (await git(repo, ["rev-list", "--count", "HEAD"])).trim();
    const parent = (await git(repo, ["rev-parse", "HEAD^"])).trim();

    if (count !== "2" || parent !== baseCommit) {
      throw new Error(
        `The tutorial repository must have a two-commit base/head history: ${count}`,
      );
    }

    const validationAssets = path.join(temporaryRoot, "assets");
    await mkdir(validationAssets);

    for (const name of ["document.json", "trace.json", "software-map.json"])
      await cp(path.join(tutorialDir, name), path.join(validationAssets, name));

    const pins =
      JSON.stringify({ base: baseCommit, head: commit }, null, 2) + "\n";

    await writeFile(path.join(validationAssets, "pins.json"), pins);

    const local = openLocalSessionStore(
      path.join(temporaryRoot, "validation.db"),
    );

    let peekCount: number;

    try {
      const { snapshot } = await createNativeTutorial({
        assetsRoot: validationAssets,
        sampleRoot: repo,
        ...local,
      });

      peekCount = sourceReferences(snapshot.document).length;
    } finally {
      await local.data.close();
      await local.store.close();
    }

    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "pins.json"), pins);
    const gitStub = path.join(outDir, "git-stub");
    await rm(gitStub, { recursive: true, force: true });

    for (const entry of [
      "logs",
      "hooks",
      "dev-fast",
      "COMMIT_EDITMSG",
      "description",
    ]) {
      await rm(path.join(repo, ".git", entry), {
        recursive: true,
        force: true,
      });
    }

    // cp + rm instead of rename: the temp dir can sit on another filesystem.
    await cp(path.join(repo, ".git"), gitStub, { recursive: true });
    await makeTreeOwnerWritable(gitStub);

    return { baseCommit, commit, peekCount };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/* Git makes loose objects read-only because their names are content hashes.
   The shipped copy is an application resource, where the bundle signature
   provides integrity. Squirrel must be able to remove macOS quarantine data
   from every resource before it installs an update. */
async function makeTreeOwnerWritable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await makeTreeOwnerWritable(absolute);
      continue;
    }

    if (!entry.isFile()) continue;

    const current = await stat(absolute);

    if ((current.mode & 0o200) === 0) {
      await chmod(absolute, current.mode | 0o200);
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...COMMIT_ENV },
  });

  return stdout;
}

if (process.argv[1] === import.meta.filename) {
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;
  const built = await buildTutorialAssets({ outDir });
  process.stdout.write(
    `Tutorial assets built: commit ${built.commit}, ${built.peekCount} code ranges.\n`,
  );
}
