import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stageWhiteboardDocs } from "../apps/whiteboard-desktop/scripts/stage-whiteboard-runtime.mjs";
import { parseVersion } from "./whiteboard-cli-release.mjs";

/** Pack from the workspace, then add the docs and version metadata shipped by Desktop. */
export async function packWhiteboardCli({ version, commit }, outputDirectory) {
  parseVersion(version);

  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  if (actualCommit !== commit)
    throw new Error("Release source differs from the planned commit");
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "review-cli-pack-"));
  const manifestPath = "packages/whiteboard/package.json";
  const original = await readFile(manifestPath, "utf8");

  try {
    const pkg = JSON.parse(original);
    pkg.version = version;
    pkg.gitHead = commit;
    await writeFile(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@dev.fast/whiteboard",
        "pack",
        "--pack-destination",
        scratch,
      ],
      { stdio: "inherit" },
    );
    execFileSync("tar", [
      "-xzf",
      path.join(scratch, `dev.fast-whiteboard-${version}.tgz`),
      "-C",
      scratch,
    ]);
    const staged = path.join(scratch, "package");
    await stageWhiteboardDocs(staged);

    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", output],
      { cwd: staged, stdio: "inherit" },
    );

    return path.join(output, `dev.fast-whiteboard-${version}.tgz`);
  } finally {
    await writeFile(manifestPath, original);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(await readFile("release-plan.json", "utf8"));
  console.log(
    await packWhiteboardCli(plan, process.argv[2] || "release-artifacts"),
  );
}
