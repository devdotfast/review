import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { createSessionApi as createJsonReviewApi } from "../review-api/http.js";
import { openLocalSessionStore } from "../review-api/local-data.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const hasJj = spawnSync("jj", ["--version"]).status === 0;

test.skipIf(!hasJj)(
  "structural requests resolve pinned revisions from a jj workspace inside another Git repository",
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "review-structural-workspace-"),
    );

    roots.push(root);

    const run = (cwd: string, command: string, args: string[]) =>
      execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    const git = (cwd: string, args: string[]) => run(cwd, "git", args);
    const source = path.join(root, "source");
    const outer = path.join(root, "outer");
    await mkdir(source);
    await mkdir(outer);
    git(source, ["init", "-b", "main"]);
    git(source, ["config", "user.name", "Test"]);
    git(source, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(source, "file name.ts"), "base\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "base"]);
    const base = git(source, ["rev-parse", "HEAD"]);
    await writeFile(path.join(source, "file name.ts"), "head\n");
    git(source, ["commit", "-am", "head"]);
    const head = git(source, ["rev-parse", "HEAD"]);
    git(source, ["checkout", "-b", "base-side", base]);
    await writeFile(path.join(source, "file name.ts"), "divergent base\n");
    git(source, ["commit", "-am", "divergent base"]);
    const divergentBase = git(source, ["rev-parse", "HEAD"]);
    git(source, ["checkout", "main"]);
    git(outer, ["init", "-b", "unrelated"]);
    run(source, "jj", ["git", "init", "--colocate"]);
    const workspace = path.join(outer, "workspace");
    run(source, "jj", ["workspace", "add", workspace, "-r", head]);
    // A Git-only consumer discovers the enclosing repo from the jj workspace.
    expect(git(workspace, ["rev-parse", "--show-toplevel"])).toBe(
      await realpath(outer),
    );

    // Exercise the same Git-only discovery and revision reads as diffr without
    // requiring a Rust binary in the JS unit-test environment.
    const executable = path.join(root, "diffr");
    await writeFile(
      executable,
      `#!${process.execPath}
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
const repo = args[args.indexOf('--repo') + 1];
const revisions = args
  .slice(args.indexOf('ndjson') + 1, args.indexOf('--'))
  .filter(arg => arg !== '--stream-annotations');
const range = revisions.length === 1 ? revisions[0].split('...') : revisions;
const file = args[args.indexOf('--') + 1];
const read = rev => execFileSync('git', ['-C', repo, 'show', rev + ':' + file], {encoding:'utf8'});
console.log(JSON.stringify({type:'start',version:4,lhs:{type:'revision',rev:range[0]},rhs:{type:'revision',rev:range[1]},files:[{file:{rhs:{path:file,oid:range[1],mode:'100644'}},status:'modified'}]}));
console.log(JSON.stringify({type:'file',file:{rhs:{path:file,oid:range[1],mode:'100644'}},diff:{type:'text',lhs:{text:read(range[0])},rhs:{text:read(range[1])},stats:{textual:{added:1,removed:1},visible:{added:1,removed:1}},structural_changes:{base:[[0,1]],head:[[0,1]]}}}));
console.log(JSON.stringify({type:'complete',succeeded:1,failed:0}));
`,
      { mode: 0o755 },
    );
    vi.stubEnv("REVIEW_DIFFR_BINARY", executable);
    const local = openLocalSessionStore(path.join(root, "reviews.db"));

    try {
      const repository = await local.data.register(workspace);

      const pins = await local.data.resolvePins(
        repository.id,
        divergentBase,
        head,
      );

      const { sessionId } = await local.store.execute({
        commandId: randomUUID(),
        operation: { type: "create", title: "Structural", pins },
      });

      const app = createJsonReviewApi(local.store, local.data);

      for (const commit of [undefined, head]) {
        const query = new URLSearchParams({
          file: "file name.ts",
          version: String(local.store.read(sessionId).version),
        });

        if (commit) query.set("commit", commit);

        const response = await app.request(
          `/${sessionId}/structural-diff?${query}`,
        );

        expect(response.status).toBe(200);

        const events = (await response.text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));

        expect(events.find((event) => event.type === "error")).toBeUndefined();
        expect(events.find((event) => event.type === "file")).toMatchObject({
          diff: {
            lhs: { text: commit ? "base\n" : "divergent base\n" },
            rhs: { text: "head\n" },
          },
        });
      }

      const invalid = await app.request(
        `/${sessionId}/structural-diff?version=999`,
      );

      expect(invalid.status).toBe(404);
    } finally {
      await local.data.close();
      await local.store.close();
    }
  },
);
