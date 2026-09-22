import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  runWorkflow,
  updateComment,
} from "../actions/author-and-share/run.mjs";

const sha = "a".repeat(40);

const exec = promisify(execFile);

const url =
  "https://app.dev.fast/s/11111111-1111-4111-8111-111111111111#capability";

async function fixture(t, author = "node author.mjs") {
  const root = await mkdtemp(path.join(tmpdir(), "review-action-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, "review");
  const log = path.join(root, "calls.jsonl");
  await writeFile(
    cli,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2), home=process.env.DEV_REVIEW_HOME;
appendFileSync(process.env.TEST_LOG, JSON.stringify({args,home})+'\\n');
const out=value=>console.log(JSON.stringify(value));
if(args[0]==='server' && args[1]==='start') {
 writeFileSync(home+'/ready','');
 process.on('SIGTERM',()=>{appendFileSync(process.env.TEST_LOG,JSON.stringify({stopped:true})+'\\n');process.exit(0)});
 setInterval(()=>{},1000);
} else if(args[0]==='server') { if(!existsSync(home+'/ready')) process.exit(1); out({ready:true}); }
else if(args[1]==='review_register_repository') out({id:'repo'});
else if(args[1]==='review_resolve_pins') { const pins=JSON.parse(args[2]); writeFileSync(home+'/pins',JSON.stringify(pins)); out(pins); }
else if(args[1]==='review_list') { const pins=JSON.parse(readFileSync(home+'/pins','utf8')); out(existsSync(home+'/committed')?[{reviewId:'review-id',version:0,pins,target:{kind:'commits',...pins}}]:[]); }
else if(args[0]==='share') { if(process.env.TEST_SHARE_ERROR) { out({error:{code:'share_failed',message:process.env.TEST_SHARE_ERROR}}); console.error(process.env.TEST_SHARE_ERROR); process.exit(1); } if(!process.env.DEV_REVIEW_SHARE_TOKEN) process.exit(3); out({shareId:'11111111-1111-4111-8111-111111111111',version:0,url:args.includes('--preview')?'${url.replace("#", "?app=preview#")}':'${url}'}); }
else process.exit(2);
`,
    { mode: 0o700 },
  );
  await writeFile(
    path.join(root, "author.mjs"),
    `import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.env.DEV_REVIEW_SHARE_TOKEN,undefined);
assert.equal(process.env.REVIEW_GITHUB_TOKEN,undefined);
assert.equal(process.env.MODEL_SECRET,'model-token');
assert.equal(process.env.REVIEW_HEAD,process.env.TEST_EXPECTED_HEAD || '${sha}');
assert.ok(readFileSync(process.env.REVIEW_PROMPT_FILE,'utf8').includes('Custom prompt: $not_shell'));
writeFileSync(process.env.DEV_REVIEW_HOME+'/committed','');
writeFileSync('authored-pins.json',process.env.REVIEW_PINS_JSON);
`,
  );
  await writeFile(
    path.join(root, "event.json"),
    JSON.stringify({
      pull_request: {
        number: 42,
        head: { sha, repo: { full_name: "owner/repo" } },
        base: { repo: { full_name: "owner/repo" } },
      },
    }),
  );

  const env = {
    ...process.env,
    REVIEW_CLI: cli,
    RUNNER_TEMP: root,
    REVIEW_REPOSITORY_PATH: root,
    REVIEW_BASE: sha,
    REVIEW_HEAD: sha,
    REVIEW_AUTHOR_COMMAND: author,
    REVIEW_PROMPT: "Custom prompt: $not_shell",
    DEV_REVIEW_SHARE_TOKEN: "share-token",
    REVIEW_GITHUB_TOKEN: "github-token",
    MODEL_SECRET: "model-token",
    REVIEW_COMMENT: "false",
    TEST_LOG: log,
    GITHUB_OUTPUT: path.join(root, "output"),
    GITHUB_STEP_SUMMARY: path.join(root, "summary"),
    GITHUB_EVENT_PATH: path.join(root, "event.json"),
    GITHUB_REPOSITORY: "owner/repo",
  };

  return {
    root,
    env,
    calls: async () =>
      (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
  };
}

async function divergedPullRequest(t) {
  const f = await fixture(t);

  const git = async (...args) =>
    (await exec("git", ["-C", f.root, ...args])).stdout.trim();

  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Review test");
  await git("config", "user.email", "review@example.com");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(f.root, "guidance.txt"), "Original guidance\n");
  await git("add", "guidance.txt");
  await git("commit", "-m", "Common ancestor");
  const mergeBase = await git("rev-parse", "HEAD");
  await git("switch", "-c", "feature");
  await writeFile(path.join(f.root, "guidance.txt"), "Updated guidance\n");
  await git("add", "guidance.txt");
  await git("commit", "-m", "PR change");
  const head = await git("rev-parse", "HEAD");
  await git("switch", "main");
  await writeFile(path.join(f.root, "unrelated.txt"), "Only on main\n");
  await git("add", "unrelated.txt");
  await git("commit", "-m", "Unrelated main change");
  const base = await git("rev-parse", "HEAD");
  await git("switch", "feature");
  await writeFile(
    f.env.GITHUB_EVENT_PATH,
    JSON.stringify({
      pull_request: {
        number: 42,
        head: { sha: head, repo: { full_name: "owner/repo" } },
        base: { sha: base, repo: { full_name: "owner/repo" } },
      },
    }),
  );

  return {
    ...f,
    env: {
      ...f.env,
      REVIEW_BASE: "",
      REVIEW_HEAD: head,
      TEST_EXPECTED_HEAD: head,
    },
    git,
    base,
    head,
    mergeBase,
  };
}

test("PR defaults exclude unrelated changes made on the base branch", async (t) => {
  const f = await divergedPullRequest(t);
  await runWorkflow(f.env);

  const pins = JSON.parse(
    await readFile(path.join(f.root, "authored-pins.json"), "utf8"),
  );

  assert.equal(pins.base, f.mergeBase);
  assert.equal(pins.head, f.head);
  assert.equal(
    await f.git("diff", "--numstat", pins.base, pins.head),
    "1\t1\tguidance.txt",
  );
});

test("missing PR history fails before starting the author or publishing", async (t) => {
  const f = await divergedPullRequest(t);
  const checkout = path.join(f.root, "shallow");
  await exec("git", [
    "clone",
    "--no-local",
    "--depth",
    "1",
    "--branch",
    "feature",
    f.root,
    checkout,
  ]);
  await exec("git", [
    "-C",
    checkout,
    "fetch",
    "--depth",
    "1",
    "origin",
    "main",
  ]);
  await assert.rejects(
    runWorkflow({ ...f.env, REVIEW_REPOSITORY_PATH: checkout }),
    /Could not resolve the pull request merge base.*fetch-depth: 0/,
  );
  assert.equal((await readdir(f.root)).includes("calls.jsonl"), false);
});

for (const pullRequest of [true, false]) {
  test(`preserves explicit base comparisons with pullRequest=${pullRequest}`, async (t) => {
    const f = await divergedPullRequest(t);
    await runWorkflow({
      ...f.env,
      REVIEW_BASE: f.base,
      GITHUB_EVENT_PATH: pullRequest ? f.env.GITHUB_EVENT_PATH : undefined,
    });

    const pins = JSON.parse(
      await readFile(path.join(f.root, "authored-pins.json"), "utf8"),
    );

    assert.equal(pins.base, f.base);
    assert.equal(
      await f.git("diff", "--numstat", pins.base, pins.head),
      "1\t1\tguidance.txt\n0\t1\tunrelated.txt",
    );
  });
}

for (const preview of [undefined, "false", "true"]) {
  test(`authors and exports the share link with preview=${preview}`, async (t) => {
    const f = await fixture(t);
    const result = await runWorkflow({ ...f.env, REVIEW_PREVIEW: preview });

    const expectedUrl =
      preview === "true" ? url.replace("#", "?app=preview#") : url;

    assert.equal(result.url, expectedUrl);
    assert.ok(
      (await readFile(f.env.GITHUB_OUTPUT, "utf8")).includes(
        `url=${expectedUrl}`,
      ),
    );
    assert.match(await readFile(f.env.GITHUB_OUTPUT, "utf8"), /version=0/);
    assert.ok(
      (await readFile(f.env.GITHUB_STEP_SUMMARY, "utf8")).includes(expectedUrl),
    );
    const calls = await f.calls();
    assert.ok(
      calls.find((c) => c.args?.[0] === "share").args.includes("--request-id"),
    );
    assert.equal(calls.at(-1).stopped, true);
    assert.equal(
      (await readdir(f.root)).some((name) => name.startsWith("review-action-")),
      false,
    );
  });
}

for (const [name, author, error] of [
  ["agent failure", "exit 7", /Author command failed/],
  ["missing commit", "true", /found 0/],
]) {
  test(`${name} never publishes and still tears down the server`, async (t) => {
    const f = await fixture(t, author);
    await assert.rejects(runWorkflow(f.env), error);
    const calls = await f.calls();
    assert.equal(
      calls.some((c) => c.args?.[0] === "share"),
      false,
    );
    assert.equal(calls.at(-1).stopped, true);
    assert.equal(
      (await readdir(f.root)).some((name) => name.startsWith("review-action-")),
      false,
    );
  });
}

test("reports the CLI stderr when sharing fails and still cleans up", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runWorkflow({
      ...f.env,
      TEST_SHARE_ERROR: "Your sign-in has expired. Sign in again to share.",
    }),
    /Your sign-in has expired\. Sign in again to share\./,
  );
  assert.equal((await f.calls()).at(-1).stopped, true);
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith("review-action-")),
    false,
  );
});

test("retains link outputs when commenting fails", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runWorkflow(
      { ...f.env, REVIEW_COMMENT: "true" },
      async () => new Response(null, { status: 403 }),
    ),
    /comment request failed/,
  );
  assert.ok((await readFile(f.env.GITHUB_STEP_SUMMARY, "utf8")).includes(url));
  assert.equal((await f.calls()).at(-1).stopped, true);
});

test("updates its bot comment across pages, leaves human comments alone and skips stale heads", async () => {
  const calls = [];

  const send = async (input, init) => {
    calls.push({ url: input, init });

    if (input.includes("/pulls/")) return Response.json({ head: { sha } });

    if (init.method === "PATCH") return Response.json({});

    if (input.endsWith("page=1"))
      return Response.json(
        Array.from({ length: 100 }, () => ({
          user: { login: "human" },
          body: "<!-- dev-fast-review -->",
        })),
      );

    return Response.json([
      {
        id: 23,
        user: { login: "github-actions[bot]" },
        body: "<!-- dev-fast-review -->\nOld link",
      },
    ]);
  };

  const input = {
    apiUrl: "https://api.github.com",
    repository: "owner/repo",
    number: 42,
    head: sha,
    url,
    token: "token",
  };

  assert.equal(await updateComment(input, send), true);
  assert.equal(
    calls.at(-1).url,
    "https://api.github.com/repos/owner/repo/issues/comments/23",
  );
  assert.ok(JSON.parse(calls.at(-1).init.body).body.includes(url));
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 0);
  const before = calls.length;
  assert.equal(
    await updateComment({ ...input, head: "b".repeat(40) }, send),
    false,
  );
  assert.equal(calls.length, before + 1);
});

test("creates the first bot comment with the share URL", async () => {
  const calls = [];
  await updateComment(
    {
      apiUrl: "https://api.github.com",
      repository: "owner/repo",
      number: 42,
      head: sha,
      url,
      token: "token",
    },
    async (input, init) => {
      calls.push({ input, init });

      return Response.json(
        input.includes("/pulls/")
          ? { head: { sha } }
          : init.method === "GET"
            ? []
            : {},
      );
    },
  );
  assert.equal(calls.at(-1).init.method, "POST");
  assert.ok(JSON.parse(calls.at(-1).init.body).body.includes(url));
});

test("rejects fork events before starting the server", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.env.GITHUB_EVENT_PATH,
    JSON.stringify({
      pull_request: {
        number: 42,
        head: { repo: { full_name: "fork/repo" } },
        base: { repo: { full_name: "owner/repo" } },
      },
    }),
  );
  await assert.rejects(runWorkflow(f.env), /Fork PR/);
  assert.equal((await readdir(f.root)).includes("calls.jsonl"), false);
});

test("Git askpass only offers the job token for GitHub", async (t) => {
  const f = await fixture(t, `node author.mjs; node check-askpass.mjs`);
  await writeFile(
    path.join(f.root, "check-askpass.mjs"),
    `import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(execFileSync(process.env.GIT_ASKPASS,["Username for 'https://github.com':"],{encoding:'utf8'}).trim(),'x-access-token');
assert.throws(()=>execFileSync(process.env.GIT_ASKPASS,["Password for 'https://example.com':"],{stdio:'ignore'}));
`,
  );
  await runWorkflow(f.env);
});

test("normal cancellation terminates the author and server and removes scratch state", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const f = await fixture(t, "node waiting-author.mjs");
  await writeFile(
    path.join(f.root, "waiting-author.mjs"),
    `import {writeFileSync} from 'node:fs'; writeFileSync('agent-ready',''); setInterval(()=>{},1000);`,
  );

  const child = spawn(
    process.execPath,
    [path.resolve("actions/author-and-share/run.mjs")],
    { env: f.env, stdio: "ignore" },
  );

  t.after(() => child.kill("SIGKILL"));
  const exit = once(child, "exit");
  let ready = false;

  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(f.root)).includes("agent-ready")) {
      ready = true;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(ready, true);
  child.kill("SIGTERM");
  await exit;
  const calls = await f.calls();
  assert.equal(calls.at(-1).stopped, true);
  assert.equal(
    calls.some((c) => c.args?.[0] === "share"),
    false,
  );
  assert.equal(
    (await readdir(f.root)).some((name) => name.startsWith("review-action-")),
    false,
  );
});
