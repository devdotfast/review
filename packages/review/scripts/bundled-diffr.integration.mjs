import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "tsdown";
import { afterAll, beforeAll, describe, test } from "vitest";

import { stageDiffrBinary } from "../../../apps/review-desktop/scripts/stage-review-runtime.mjs";
import {
  cleanupTempDirs,
  gitRepository,
  tempDir,
} from "../src/review-test-utils.ts";

let structuralDiff, readDiffrConfig, setDiffrConfigValue;

const source = path.resolve(import.meta.dirname, "../bin/diffr");

async function collect(repositoryPath, base, head, paths, kind = "trees") {
  return Array.fromAsync(
    structuralDiff({
      repositoryPath,
      comparison: { kind, base, head },
      paths,
      signal: AbortSignal.timeout(15_000),
    }),
  );
}

function successfulFiles(events, count) {
  assert.equal(events[0].type, "start");
  assert.equal(events[0].version, 4);
  assert.deepEqual(events.at(-1), {
    type: "complete",
    succeeded: count,
    failed: 0,
  });
  const files = events.filter((event) => event.type === "file");
  assert.equal(files.length, count);

  for (const file of files) {
    assert.equal(file.error, undefined);
    assert.ok(file.diff);
  }

  return files;
}

describe("Relocated runtime diffr integrates with Review streams and settings", () => {
  let root, repository, runtime, trap, sentinel, base, head;
  const savedEnv = { ...process.env };
  afterAll(async () => {
    process.env = savedEnv;
    await cleanupTempDirs();
  });
  beforeAll(async () => {
    root = await tempDir("review-bundled-diffr-");
    repository = await gitRepository();
    runtime = path.join(root, "runtime with spaces");
    trap = path.join(root, "trap");
    sentinel = path.join(root, "host-used");
    await mkdir(trap);
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    const git = (...args) =>
      execFileSync("git", ["-C", repository, ...args], {
        encoding: "utf8",
      }).trim();

    await writeFile(
      path.join(repository, "modified.ts"),
      "export function answer() { return 1; }\n",
    );
    await writeFile(
      path.join(repository, "deleted.ts"),
      "export const obsolete = true;\n",
    );
    git("add", ".");
    git("commit", "-qm", "base");
    base = git("rev-parse", "HEAD");
    await writeFile(
      path.join(repository, "modified.ts"),
      "export function answer() { return 42; }\n",
    );
    await writeFile(
      path.join(repository, "space name.ts"),
      "export const greeting = 'hello';\n",
    );
    await rm(path.join(repository, "deleted.ts"));
    git("add", "-A");
    git("commit", "-qm", "head");
    head = git("rev-parse", "HEAD");
    await stageDiffrBinary(runtime, source);
    await build({
      config: false,
      entry: {
        "structural-diff": path.resolve(
          import.meta.dirname,
          "../src/server/structural-diff.ts",
        ),
        "diffr-config": path.resolve(
          import.meta.dirname,
          "../src/server/diffr-config.ts",
        ),
      },
      outDir: path.join(runtime, "dist"),
      platform: "node",
      format: "esm",
      dts: false,
      deps: { alwaysBundle: [/^@dev\.fast\//] },
    });

    const load = (name) =>
      import(
        /* @vite-ignore */ pathToFileURL(
          path.join(runtime, "dist", `${name}.mjs`),
        ).href
      );

    ({ structuralDiff } = await load("structural-diff"));
    ({ readDiffrConfig, setDiffrConfigValue } = await load("diffr-config"));
    await writeFile(
      path.join(trap, "diffr"),
      `#!/bin/sh\ntouch '${sentinel}'\nexit 97\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${trap}${path.delimiter}${savedEnv.PATH}`;
    delete process.env.REVIEW_DIFFR_BINARY;
  });

  test("bundled binary streams added, modified and deleted files without using PATH", async () => {
    const events = await collect(repository, base, head);
    const files = successfulFiles(events, 3);
    assert.deepEqual(events[0].files.map(({ status }) => status).sort(), [
      "added",
      "deleted",
      "modified",
    ]);

    const added = files.find(({ file }) => file.rhs?.path === "space name.ts");

    const deleted = files.find(({ file }) => file.lhs?.path === "deleted.ts");

    const modified = files.find(({ file }) => file.rhs?.path === "modified.ts");

    assert.equal(modified.diff.type, "text");
    assert.match(modified.diff.lhs.text, /return 1;/);
    assert.match(modified.diff.rhs.text, /return 42;/);
    assert.ok(modified.diff.structural_changes.base.length);
    assert.ok(modified.diff.structural_changes.head.length);
    assert.equal(added.file.lhs, undefined);
    assert.equal(deleted.file.rhs, undefined);
    assert.equal(existsSync(sentinel), false);
  });

  test("merge-base comparison filters a path containing spaces", async () => {
    const events = await collect(
      repository,
      base,
      head,
      ["space name.ts"],
      "merge-base",
    );

    const [file] = successfulFiles(events, 1);
    assert.equal(file.file.rhs.path, "space name.ts");
  });

  test("identical revisions produce a complete empty stream", async () => {
    const events = await collect(repository, head, head);
    successfulFiles(events, 0);
    assert.deepEqual(events[0].files, []);
  });

  test("settings values and edits round-trip through the staged binary", async () => {
    const config = await readDiffrConfig(repository);
    assert.ok(Number.isInteger(config.values.plugins.bundled.context.lines));
    assert.equal(config.values.plugins.bundled.summarize.api_key, undefined);
    assert.ok(
      ["config", "environment", "missing"].includes(config.credentialSource),
    );

    const updated = await setDiffrConfigValue(
      "plugins.bundled.context.lines",
      7,
      repository,
    );

    assert.equal(updated.values.plugins.bundled.context.lines, 7);
    assert.equal(updated.changed, true);
    assert.equal(updated.error, undefined);
    assert.equal(
      (await readDiffrConfig(repository)).values.plugins.bundled.context.lines,
      7,
    );
    assert.equal(existsSync(sentinel), false);
  });

  test("an explicit executable override takes precedence over the bundle", async () => {
    const override = path.join(root, "override");
    await writeFile(
      override,
      `#!/bin/sh\necho explicit-override >&2\nexit 93\n`,
      { mode: 0o755 },
    );
    process.env.REVIEW_DIFFR_BINARY = override;
    await assert.rejects(collect(repository, base, head), /explicit-override/);
    assert.equal(existsSync(sentinel), false);
  });

  test("an unbundled installation falls back to PATH", async () => {
    delete process.env.REVIEW_DIFFR_BINARY;
    await rm(path.join(runtime, "bin"), { recursive: true, force: true });
    await assert.rejects(
      collect(repository, base, head),
      /diffr exited with 97/,
    );
    assert.equal(existsSync(sentinel), true);
  });

  describe("a working host installation coexists with the Desktop bundle", () => {
    let called, launcher;
    beforeAll(async () => {
      await stageDiffrBinary(runtime, source);
      const host = path.join(root, "host");
      const traced = path.join(root, "traced-host");
      called = path.join(root, "host-called");
      await Promise.all([mkdir(host), mkdir(traced)]);
      const binary = path.join(host, "diffr");
      await copyFile(source, binary);
      launcher = path.join(traced, "diffr");
      await writeFile(
        launcher,
        `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(called)}, "called\\n");
const result = spawnSync(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${traced}${path.delimiter}${host}${path.delimiter}${savedEnv.PATH}`;
    });

    test("prefers the bundle over a working host binary", async () => {
      delete process.env.REVIEW_DIFFR_BINARY;
      successfulFiles(await collect(repository, base, head), 3);
      await readDiffrConfig(repository);
      assert.equal(existsSync(called), false);
    });

    test("an explicit host override runs real diffs and settings", async () => {
      process.env.REVIEW_DIFFR_BINARY = launcher;
      successfulFiles(await collect(repository, base, head), 3);
      assert.equal(existsSync(called), true);
      await rm(called);
      await readDiffrConfig(repository);
      assert.equal(existsSync(called), true);
      await rm(called);
    });

    test("without a bundle the host binary runs real diffs and settings", async () => {
      delete process.env.REVIEW_DIFFR_BINARY;
      await rm(path.join(runtime, "bin"), { recursive: true, force: true });
      successfulFiles(await collect(repository, base, head), 3);
      assert.equal(existsSync(called), true);
      await rm(called);
      await readDiffrConfig(repository);
      assert.equal(existsSync(called), true);
    });
  });
});
