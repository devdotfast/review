import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("fast CLI build skips fresh output, rebuilds changed inputs, and never stamps failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-cli-build-"));

  try {
    const packageDir = path.join(root, "packages/progressive-review");

    for (const directory of [
      "apps/review-desktop/scripts",
      "packages/progressive-review/src",
      "packages/local-vcs",
      "packages/review-protocol",
      "packages/trace-shared",
      "bin",
    ]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }

    for (const name of ["build-review-cli.sh", "freshness.sh"]) {
      await copyFile(
        new URL(`../apps/review-desktop/scripts/${name}`, import.meta.url),
        path.join(root, "apps/review-desktop/scripts", name),
      );
    }

    for (const name of ["tsdown.config.ts", "tsconfig.json", "package.json"])
      await writeFile(path.join(packageDir, name), "{}");

    for (const name of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".nvmrc",
    ])
      await writeFile(path.join(root, name), "fixture");
    await writeFile(path.join(root, ".gitignore"), "dist/\nbuild-count\n");
    const fakePnpm = path.join(root, "bin/pnpm");
    await writeFile(
      fakePnpm,
      '#!/bin/sh\nif [ "$FAIL_BUILD" = 1 ]; then exit 17; fi\nmkdir -p "$2/packages/progressive-review/dist"\ntouch "$2/packages/progressive-review/dist/cli.js" "$2/packages/progressive-review/dist/build-info.json"\nprintf "built\\n" >> "$2/build-count"\n',
    );
    await chmod(fakePnpm, 0o755);

    const git = (...args) =>
      execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

    git("init", "-b", "main");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    );

    const env = {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
    };

    const run = (extra = {}) =>
      execFileSync(
        "bash",
        [path.join(root, "apps/review-desktop/scripts/build-review-cli.sh")],
        { env: { ...env, ...extra }, encoding: "utf8" },
      );

    run();
    assert.match(run(), /output is current/);
    const stamp = path.join(packageDir, "dist/.dev-build-stamp");
    await writeFile(
      path.join(packageDir, "src/changed.ts"),
      "export const changed = true;",
    );
    await utimes(stamp, new Date(0), new Date(0));
    run();
    assert.match(run(), /output is current/);
    await writeFile(
      path.join(root, "packages/review-protocol/tsconfig.json"),
      "{}",
    );
    await utimes(stamp, new Date(0), new Date(0));
    assert.throws(() => run({ FAIL_BUILD: "1" }), { status: 17 });
    const before = await readFile(path.join(root, "build-count"), "utf8");
    assert.equal(before.trim().split("\n").length, 2);
    run();
    assert.match(run(), /output is current/);
    assert.equal(
      (await readFile(path.join(root, "build-count"), "utf8"))
        .trim()
        .split("\n").length,
      3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
