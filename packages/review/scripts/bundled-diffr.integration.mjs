import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageDiffrBinary } from "../../../apps/review-desktop/scripts/stage-review-runtime.mjs";
import {
  readDiffrConfig,
  setDiffrConfigValue,
} from "../src/server/diffr-config.ts";
import {
  applyBundledDiffrBinary,
  structuralDiff,
} from "../src/server/structural-diff.ts";

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

await test("Desktop staged diffr integrates with Review streams and settings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-bundled-diffr-"));
  const savedEnv = { ...process.env };
  t.after(async () => {
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  });
  const repository = path.join(root, "repository");
  const runtime = path.join(root, "runtime with spaces");
  const trap = path.join(root, "trap");
  const sentinel = path.join(root, "host-used");
  await Promise.all([mkdir(repository), mkdir(trap)]);
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Review test");
  git("config", "user.email", "review@example.invalid");
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
  const base = git("rev-parse", "HEAD");
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
  const head = git("rev-parse", "HEAD");
  await stageDiffrBinary(runtime, source);
  await writeFile(
    path.join(trap, "diffr"),
    `#!/bin/sh\ntouch '${sentinel}'\nexit 97\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${trap}${path.delimiter}${savedEnv.PATH}`;
  delete process.env.REVIEW_DIFFR_BINARY;
  applyBundledDiffrBinary(runtime, process.env);

  await t.test(
    "bundled binary streams added, modified and deleted files without using PATH",
    async () => {
      const events = await collect(repository, base, head);
      const files = successfulFiles(events, 3);
      assert.deepEqual(events[0].files.map(({ status }) => status).sort(), [
        "added",
        "deleted",
        "modified",
      ]);

      const added = files.find(
        ({ file }) => file.rhs?.path === "space name.ts",
      );

      const deleted = files.find(({ file }) => file.lhs?.path === "deleted.ts");

      const modified = files.find(
        ({ file }) => file.rhs?.path === "modified.ts",
      );

      assert.equal(modified.diff.type, "text");
      assert.match(modified.diff.lhs.text, /return 1;/);
      assert.match(modified.diff.rhs.text, /return 42;/);
      assert.ok(modified.diff.structural_changes.base.length);
      assert.ok(modified.diff.structural_changes.head.length);
      assert.equal(added.file.lhs, undefined);
      assert.equal(deleted.file.rhs, undefined);
      assert.equal(existsSync(sentinel), false);
    },
  );

  await t.test(
    "merge-base comparison filters a path containing spaces",
    async () => {
      const events = await collect(
        repository,
        base,
        head,
        ["space name.ts"],
        "merge-base",
      );

      const [file] = successfulFiles(events, 1);
      assert.equal(file.file.rhs.path, "space name.ts");
    },
  );

  await t.test(
    "identical revisions produce a complete empty stream",
    async () => {
      successfulFiles(await collect(repository, head, head), 0);
    },
  );

  await t.test(
    "settings schema and edits round-trip through the staged binary",
    async () => {
      const config = await readDiffrConfig(repository);
      assert.ok(config.schema.properties);

      const updated = await setDiffrConfigValue(
        "plugins.bundled.context.lines",
        7,
        repository,
      );

      assert.equal(updated.values.plugins.bundled.context.lines, 7);
      assert.equal(
        (await readDiffrConfig(repository)).values.plugins.bundled.context
          .lines,
        7,
      );
      assert.equal(existsSync(sentinel), false);
    },
  );

  await t.test(
    "an explicit executable override takes precedence over the bundle",
    async () => {
      const override = path.join(root, "override");
      await writeFile(
        override,
        `#!/bin/sh\necho explicit-override >&2\nexit 93\n`,
        { mode: 0o755 },
      );
      process.env.REVIEW_DIFFR_BINARY = override;
      applyBundledDiffrBinary(runtime, process.env);
      await assert.rejects(
        collect(repository, base, head),
        /explicit-override/,
      );
      assert.equal(existsSync(sentinel), false);
    },
  );

  await t.test("an unbundled installation falls back to PATH", async () => {
    delete process.env.REVIEW_DIFFR_BINARY;
    applyBundledDiffrBinary(path.join(root, "unbundled"), process.env);
    await assert.rejects(
      collect(repository, base, head),
      /diffr exited with 97/,
    );
    assert.equal(existsSync(sentinel), true);
  });
});
