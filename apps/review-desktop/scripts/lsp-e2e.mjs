/** Real Desktop -> extension host -> language server regression gate.
 * Run after app:build: node scripts/lsp-e2e.mjs [--app /path/Review.app] [--keep]
 * Linux CI: xvfb-run -a node scripts/lsp-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { chromium } from "playwright";

const exec = promisify(execFile);

const appRoot = path.resolve(import.meta.dirname, "..");

const workspace = path.resolve(appRoot, "../..");

const codeRoot = path.join(appRoot, "code-oss");

const { values } = parseArgs({
  options: { app: { type: "string" }, keep: { type: "boolean" } },
});

const bundledDiffr = values.app
  ? path.join(values.app, "Contents/Resources/app/review-runtime/bin/diffr")
  : path.join(workspace, "packages/review/bin/diffr");

const structuralDiffAvailable =
  !!process.env.REVIEW_DIFFR_BINARY ||
  existsSync(bundledDiffr) ||
  (await exec("which", ["diffr"]).then(
    () => true,
    () => false,
  ));

const root = await realpath(
  await mkdtemp(
    path.join(
      process.platform === "darwin" ? "/tmp" : os.tmpdir(),
      "review-lsp-",
    ),
  ),
);

const home = path.join(root, "home");

const profile = path.join(root, "profile");

const extension = path.join(root, "probe");

const env = {
  ...process.env,
  DEV_REVIEW_HOME: home,
  DEV_REVIEW_IMPORT_FROM: "none",
  DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
  REVIEW_LSP_E2E_ROOT: root,
};

for (const key of [
  "NODE_OPTIONS",
  "DEV_FAST_AGENT_SESSION",
  "CODEX_THREAD_ID",
  "DEV_FAST_REVIEW_TOOLING_ROOT",
  "DEV_FAST_REVIEW_SERVER_ENTRY",
])
  delete env[key];

await mkdir(path.join(profile, "User"), { recursive: true });

await mkdir(extension);

// This suite exercises language services, not first-run community onboarding.
// Seed only its disposable profile, before Electron opens the storage database.
await mkdir(path.join(profile, "User/globalStorage"), { recursive: true });

const storage = new DatabaseSync(
  path.join(profile, "User/globalStorage/state.vscdb"),
);

storage.exec(
  "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
);

storage
  .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
  .run("review.community.dontShowAgain", "true");

storage.close();

await writeFile(
  path.join(profile, "User/settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
    "editor.hover.delay": 100,
    "files.autoSave": "off",
    "editor.gotoLocation.multipleDefinitions": "goto",
    "editor.gotoLocation.multipleImplementations": "goto",
    "python.defaultInterpreterPath": (
      await exec("which", ["python3"])
    ).stdout.trim(),
  }),
);

await cp(
  path.join(import.meta.dirname, "lsp-e2e-extension.cjs"),
  path.join(extension, "extension.cjs"),
);

await writeFile(
  path.join(extension, "package.json"),
  JSON.stringify({
    name: "review-lsp-e2e",
    publisher: "review-test",
    version: "1.0.0",
    engines: { vscode: "^1.100.0" },
    main: "./extension.cjs",
    activationEvents: ["*"],
    contributes: {
      commands: [
        { command: "review.lspE2E", title: "Review E2E: Language probe" },
      ],
    },
  }),
);

const git = async (repo, ...args) =>
  (
    await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo })
  ).stdout.trim();

const mainText = (revision) =>
  [
    'import { greet, service, Worker, Service } from "./library";',
    'import { dependencyValue } from "fixture-dependency";',
    `export const revision = "${revision}";`,
    "export const value = greet();",
    "export const worker = new Worker();",
    "export const typed: Service = service;",
    "export const dependency = dependencyValue();",
    "export function left() { const shared = greet; return shared(); }",
    "export function right() { const shared = greet; return shared(); }",
    '\texport const café = "😀"; export const greeting = greet();',
    "",
  ].join("\r\n");

const libraryText = (type, value) =>
  [
    `export interface Service { run(): ${type}; }`,
    `export class Worker implements Service { run(): ${type} { return ${value}; } }`,
    `export function greet(): ${type} { return ${value}; }`,
    "export const service: Service = new Worker();",
    "",
  ].join("\n");

async function fixture(name) {
  const repo = path.join(root, name);
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "Review LSP E2E");
  await git(repo, "config", "user.email", "review-lsp@example.invalid");
  await writeFile(
    path.join(repo, ".gitignore"),
    "node_modules/\n__pycache__/\n.prepare-count\nnew-library.ts\n",
  );
  await writeFile(
    path.join(repo, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "commonjs" },
      include: ["*.ts"],
    }),
  );
  await writeFile(
    path.join(repo, "pyproject.toml"),
    '[project]\nname = "review-lsp-fixture"\nversion = "0.0.0"\nrequires-python = ">=3.10"\n',
  );
  await writeFile(
    path.join(repo, "library.ts"),
    libraryText("string", JSON.stringify(name)),
  );
  await writeFile(path.join(repo, "main.ts"), mainText("base"));
  await writeFile(
    path.join(repo, "main.py"),
    'from library_py import greet\nrevision = "base"\nvalue = greet()\n',
  );
  await writeFile(
    path.join(repo, "library_py.py"),
    'def greet() -> str:\n    return "hello"\n',
  );
  await writeFile(
    path.join(repo, "old.ts"),
    'export const renamed = greet();\nimport { greet } from "./library";\n',
  );
  await writeFile(path.join(repo, "deleted.ts"), "export const removed = 1;\n");
  await writeFile(
    path.join(repo, "prepare.cjs"),
    String.raw`const fs = require("node:fs");
const number = fs.readFileSync("library.ts", "utf8").includes("greet(): number");
fs.mkdirSync("node_modules/fixture-dependency", {recursive:true});
fs.writeFileSync("node_modules/fixture-dependency/package.json", JSON.stringify({name:"fixture-dependency",version:"1.0.0",types:"index.d.ts"}));
fs.writeFileSync("node_modules/fixture-dependency/index.d.ts", 'export declare function dependencyValue(): ' + (number ? 'number' : '"installed"') + ';\n');
fs.appendFileSync(".prepare-count", "prepared\n");
`,
  );
  await git(repo, "config", "devfast.prepare", "node prepare.cjs");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "Base P");
  const base = await git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "main.ts"), mainText("head"));
  await writeFile(
    path.join(repo, "main.py"),
    'from library_py import greet\nrevision = "head"\nvalue = greet()\n',
  );
  await git(repo, "mv", "old.ts", "renamed.ts");
  await git(repo, "rm", "deleted.ts");
  await writeFile(path.join(repo, "added.ts"), "export const added = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "Review head A");
  const head = await git(repo, "rev-parse", "HEAD");
  await mkdir(path.join(repo, "node_modules/fixture-dependency"), {
    recursive: true,
  });
  await writeFile(
    path.join(repo, "node_modules/fixture-dependency/package.json"),
    '{"name":"fixture-dependency","version":"1.0.0","types":"index.d.ts"}',
  );
  await writeFile(
    path.join(repo, "node_modules/fixture-dependency/index.d.ts"),
    'export declare function dependencyValue(): "installed";\n',
  );

  return { repo, base, head };
}

const first = await fixture("first"),
  second = await fixture("second");

const checks = [];

let app,
  browser,
  page,
  discovery,
  appLog = "",
  success = false;

const errors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(run, label, timeout = 90000) {
  const end = Date.now() + timeout;
  let cause;

  while (Date.now() < end) {
    try {
      const value = await run();

      if (value) return value;
    } catch (error) {
      cause = error;
    }

    if (app?.exitCode !== null && app?.exitCode !== undefined)
      throw new Error(`Desktop exited: ${appLog.slice(-3000)}`);
    await sleep(200);
  }

  throw new Error(`${label} timed out: ${cause?.stack ?? "not ready"}`);
}

async function launch() {
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));

  const product = JSON.parse(
    await readFile(path.join(codeRoot, "product.json"), "utf8"),
  );

  const binary = values.app
    ? path.join(values.app, "Contents/MacOS", product.nameShort)
    : process.platform === "darwin"
      ? path.join(
          codeRoot,
          ".build/electron",
          `${product.nameShort}.app/Contents/MacOS`,
          product.nameShort,
        )
      : path.join(codeRoot, ".build/electron", product.applicationName);

  const launchEnv = values.app
    ? { ...env }
    : {
        ...env,
        NODE_ENV: "development",
        VSCODE_DEV: "1",
        VSCODE_CLI: "1",
        DEV_FAST_REVIEW_SERVER_ENTRY: path.join(
          workspace,
          "packages/review/dist/server/desktop-host.js",
        ),
        DEV_FAST_REVIEW_TOOLING_ROOT: workspace,
      };

  app = spawn(
    binary,
    [
      ...(values.app ? [] : ["."]),
      "--disable-telemetry",
      "--skip-welcome",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      `--extensions-dir=${root}/extensions`,
      `--shared-data-dir=${root}/shared`,
      `--extensionDevelopmentPath=${extension}`,
      `--remote-debugging-port=${port}`,
      "--disable-extension=vscode.vscode-api-tests",
    ],
    {
      cwd: codeRoot,
      env: launchEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout.on("data", (chunk) => {
    appLog = (
      appLog + String(chunk).replace(/"token":"[^"]+"/g, '"token":"[redacted]"')
    ).slice(-500000);
  });
  app.stderr.on("data", (chunk) => {
    appLog = (
      appLog + String(chunk).replace(/"token":"[^"]+"/g, '"token":"[redacted]"')
    ).slice(-500000);
  });
  discovery = await until(async () => {
    const result = JSON.parse(
      await readFile(path.join(home, "review-desktop/server.json"), "utf8"),
    );

    const health = await (await fetch(`${result.url}/health`)).json();

    return health.ok && health.desktopAttached && result;
  }, "Desktop server");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("workbench")),
    "workbench",
  );
  page.on("pageerror", (error) => errors.push(error.message));
}

async function stop() {
  await browser?.close();
  browser = undefined;

  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise((resolve) => app.once("exit", resolve));

    const kill = (signal) => {
      try {
        process.kill(-app.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };

    kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);

    if (app.exitCode === null && app.signalCode === null) kill("SIGKILL");
  }

  app = undefined;
}

async function api(route, method = "GET", body) {
  const response = await fetch(`${discovery.url}/reviews-api${route}`, {
    method,
    headers: {
      "x-review-token": discovery.token,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const result = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`);

  return result;
}

const command = (operation) =>
  api("/commands", "POST", { commandId: randomUUID(), operation });

async function createReview(fix, title, kind = "commits") {
  const repository = await api("/repositories", "POST", { path: fix.repo });

  const pins = await api("/pins", "POST", {
    repositoryId: repository.id,
    base: fix.base,
    head: fix.head,
  });

  const review = await command({
    type: "create",
    title,
    ...(kind === "worktree"
      ? { target: { kind, repositoryId: repository.id, base: fix.base } }
      : { pins }),
  });

  const reviewId = review.reviewId;
  await command({
    type: "edit",
    reviewId,
    edit: {
      type: "insert",
      content: {
        type: "section",
        title: "Language services",
        children: [
          {
            type: "markdown",
            markdown: `# ${title}\nLanguage services use the environment selected by the review target.`,
          },
          ...["base", "head"].map((side) => ({
            type: "code_peek",
            source: {
              file: "main.ts",
              start: { side, line: 3 },
              end: { side, line: 10 },
            },
          })),
          {
            type: "code_peek",
            source: {
              file: "main.py",
              start: { side: "head", line: 1 },
              end: { side: "head", line: 3 },
            },
          },
        ],
      },
    },
  });

  return api(`/${reviewId}?full=true`);
}

async function probe(request) {
  const id = randomUUID();
  await writeFile(
    path.join(root, "request.json"),
    JSON.stringify({ ...request, id }),
  );
  await until(async () => {
    const input = page.locator(".quick-input-widget input");

    if (await input.isVisible()) await page.keyboard.press("Escape");
    await page.keyboard.press("F1");
    await input.fill(">Review E2E: Language probe");
    await page
      .getByRole("option", { name: /Review E2E: Language probe/ })
      .first()
      .click({ timeout: 1500 });

    return true;
  }, "probe command activation");

  const result = await until(
    async () =>
      JSON.parse(await readFile(path.join(root, `${id}.json`), "utf8")),
    "language probe",
  );

  assert.equal(result.error, undefined, result.error);

  return result;
}

function uri(review, side = "head", file = "main.ts", commit) {
  const query = new URLSearchParams({ version: String(review.version), side });

  if (review.pins.worktreeRevision)
    query.set("generation", review.pins.worktreeRevision);

  if (commit) query.set("commit", commit);

  return locationUri(`review-api-source://${review.reviewId}/${file}?${query}`);
}

function environmentUri(review, file) {
  const resource = new URL(uri(review));
  resource.protocol = "review-language-source:";
  resource.pathname = file;

  return locationUri(resource.href);
}

const hover = "vscode.executeHoverProvider",
  definition = "vscode.executeDefinitionProvider";

function at(text, line, word) {
  return { line, character: text.split(/\r?\n/)[line].indexOf(word) + 1 };
}

function locations(result) {
  return (result ?? []).map((item) => ({
    uri: item.targetUri ?? item.uri,
    range: item.targetSelectionRange ?? item.range,
  }));
}

function locationUri(value) {
  return value?.replace(/\?(.*)$/, (_query, encoded) => {
    const query = new URLSearchParams(decodeURIComponent(encoded));

    // Tab-follow policy is not a source coordinate. Check version, side,
    // generation and selected commit regardless of query serialization order.
    query.delete("current");
    query.sort();

    return `?${query}`;
  });
}

async function readyEnvironment(review, side = "head") {
  return until(async () => {
    const result = await api(
      `/${review.reviewId}/language-context?version=${review.version}&side=${side}`,
    );

    const environments = await api(`/${review.reviewId}/workspaces`);

    const prepared = environments.find(
      (item) => item.generation === result.identity,
    );

    assert.notEqual(prepared?.state, "failed", prepared?.log);

    return prepared?.state === "ready" && prepared;
  }, "prepared pinned environment");
}

async function expectDefinition(sourceUri, position, target, targetLine) {
  return until(async () => {
    const response = await probe({
      uri: sourceUri,
      ...position,
      feature: definition,
      open: true,
    });

    const found = locations(response.result).find(
      (item) =>
        locationUri(item.uri) ===
        (target.startsWith("review-api-source:") ||
        target.startsWith("review-language-source:")
          ? target
          : pathToFileURL(target).href),
    );

    if (!found) return false;

    if (targetLine !== undefined) {
      assert.equal(found.range[0]?.line ?? found.range.start?.line, targetLine);
    }

    return response;
  }, `definition ${target}`);
}

async function expectHover(sourceUri, position, expected) {
  return until(async () => {
    const result = await probe({
      uri: sourceUri,
      ...position,
      feature: hover,
      open: true,
    });

    return JSON.stringify(result.result).includes(expected) && result;
  }, `hover ${expected}`);
}

async function clickGreet(line) {
  const point = await line.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent.indexOf("greet");

      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 5);
      const rect = range.getBoundingClientRect();

      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    throw new Error("Inline greet token is not rendered");
  });

  const box = await line.boundingBox();
  await line.click({ position: { x: point.x - box.x, y: point.y - box.y } });
}

async function record(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

try {
  await launch();
  const review = await createReview(first, "Local LSP regression");
  const other = await createReview(second, "Other repository");
  await until(async () => {
    await api(`/${review.reviewId}/open`, "POST");
    await page
      .locator(".review-canvas-root")
      .filter({ hasText: "Local LSP regression" })
      .first()
      .waitFor({ timeout: 3000 });

    return true;
  }, "rendered review");
  const greetAt = at(mainText("head"), 3, "greet");
  const headEnvironment = await readyEnvironment(review);
  const baseEnvironment = await readyEnvironment(review, "base");
  assert.notEqual(headEnvironment.rootPath, baseEnvironment.rootPath);
  assert.equal(
    (
      await readFile(
        path.join(headEnvironment.rootPath, ".prepare-count"),
        "utf8",
      )
    ).trim(),
    "prepared",
  );

  for (const side of ["base", "head"]) {
    await expectDefinition(
      uri(review, side),
      greetAt,
      uri(review, side, "library.ts"),
      2,
    );
    await expectHover(uri(review, side), greetAt, "string");
  }

  await probe({
    uri: uri(review),
    ...greetAt,
    open: true,
    command: "editor.action.showHover",
  });
  await page
    .locator(".monaco-hover:visible")
    .filter({ hasText: "greet" })
    .first()
    .waitFor();
  await page.screenshot({ path: path.join(root, "typescript-hover.png") });
  await record(
    "base/head cross-file definitions and rendered TypeScript hover",
  );

  await expectDefinition(
    uri(review, "head", "main.py"),
    { line: 2, character: 9 },
    uri(review, "head", "library_py.py"),
    0,
  );
  await expectHover(
    uri(review, "head", "main.py"),
    { line: 2, character: 9 },
    "str",
  );
  await record("real bundled Python language server");

  for (const [feature, position, targetLine] of [
    [
      "vscode.executeTypeDefinitionProvider",
      at(mainText("head"), 4, "worker"),
      1,
    ],
    [
      "vscode.executeImplementationProvider",
      at(mainText("head"), 5, "Service"),
      1,
    ],
  ]) {
    await until(async () => {
      const result = await probe({
        uri: uri(review),
        ...position,
        feature,
        open: true,
      });

      return locations(result.result).some(
        (item) =>
          locationUri(item.uri) === uri(review, "head", "library.ts") &&
          (item.range[0]?.line ?? item.range.start?.line) === targetLine,
      );
    }, feature);
  }

  const refs = await probe({
    uri: uri(review),
    ...greetAt,
    feature: "vscode.executeReferenceProvider",
    open: true,
  });

  assert.ok(
    locations(refs.result).some(
      (item) => locationUri(item.uri) === uri(review),
    ),
  );
  await expectDefinition(
    uri(review),
    at(mainText("head"), 6, "dependencyValue"),
    environmentUri(
      review,
      path.join(
        headEnvironment.rootPath,
        "node_modules/fixture-dependency/index.d.ts",
      ),
    ),
    0,
  );
  await expectDefinition(
    uri(review),
    at(mainText("head"), 9, "greet()"),
    uri(review, "head", "library.ts"),
    2,
  );

  for (const line of [7, 8])
    await expectDefinition(
      uri(review),
      {
        line,
        character:
          mainText("head").split(/\r?\n/)[line].lastIndexOf("shared") + 1,
      },
      uri(review, "head", "main.ts"),
      line,
    );
  await record(
    "references, types, implementations, installed dependencies, duplicate scopes and UTF-16 columns",
  );

  await expectDefinition(
    uri(other),
    greetAt,
    uri(other, "head", "library.ts"),
    2,
  );
  await expectDefinition(
    uri(review),
    greetAt,
    uri(review, "head", "library.ts"),
    2,
  );

  const concurrent = await createReview(
    { ...first, base: first.head },
    "Same worktree different pins",
  );

  await expectDefinition(
    uri(concurrent),
    greetAt,
    uri(concurrent, "head", "library.ts"),
    2,
  );
  await record(
    "simultaneous reviews never cross repository or version contexts",
  );

  const originalLibrary = await readFile(
    path.join(headEnvironment.rootPath, "library.ts"),
    "utf8",
  );

  await writeFile(
    path.join(headEnvironment.rootPath, "library.ts"),
    "// local header\n" + originalLibrary,
  );

  await expectDefinition(
    uri(review, "base"),
    greetAt,
    uri(review, "base", "library.ts"),
    2,
  );
  await expectDefinition(
    uri(review),
    greetAt,
    environmentUri(review, path.join(headEnvironment.rootPath, "library.ts")),
    3,
  );

  await writeFile(
    path.join(headEnvironment.rootPath, "library.ts"),
    originalLibrary,
  );
  await record(
    "changed destinations open the environment file; matching base destinations stay in the review",
  );

  await writeFile(
    path.join(first.repo, "main.ts"),
    "// newer commit B\n" + mainText("head"),
  );
  await git(first.repo, "add", "main.ts");
  await git(first.repo, "commit", "-qm", "Newer than review");
  await writeFile(
    path.join(first.repo, "main.ts"),
    "// staged\n// newer commit B\n" + mainText("head"),
  );
  await git(first.repo, "add", "main.ts");
  await writeFile(
    path.join(first.repo, "main.ts"),
    "// unstaged\n// staged\n// newer commit B\n" + mainText("head"),
  );
  await writeFile(
    path.join(first.repo, "library.ts"),
    libraryText("number", "42"),
  );

  const status = await git(first.repo, "status", "--porcelain"),
    trees = await git(first.repo, "worktree", "list", "--porcelain");

  const workingMain = await readFile(path.join(first.repo, "main.ts"), "utf8");

  for (const side of ["base", "head"]) {
    await expectDefinition(
      uri(review, side),
      greetAt,
      uri(review, side, "library.ts"),
      2,
    );
    const result = await expectHover(uri(review, side), greetAt, "string");
    assert.equal(result.active.text, mainText(side));
    await expectDefinition(
      uri(review, side),
      {
        line: 7,
        character: mainText("head").split(/\r?\n/)[7].lastIndexOf("shared") + 1,
      },
      uri(review, side, "main.ts"),
      7,
    );
  }

  assert.equal(
    (
      await api(
        `/${review.reviewId}/file?version=${review.version}&side=head&file=main.ts`,
      )
    ).text,
    mainText("head"),
  );
  assert.equal(await git(first.repo, "status", "--porcelain"), status);
  assert.equal(await git(first.repo, "worktree", "list", "--porcelain"), trees);
  assert.equal(
    await readFile(path.join(first.repo, "main.ts"), "utf8"),
    workingMain,
  );
  await record(
    "pinned LSP ignores newer commits and staged/unstaged changes in the invoking checkout",
  );

  const managedMain = await readFile(
    path.join(headEnvironment.rootPath, "main.ts"),
    "utf8",
  );

  await writeFile(
    path.join(headEnvironment.rootPath, "main.ts"),
    managedMain.replace(
      "export const value = greet();",
      "export const value = service.run();",
    ),
  );

  const unavailable = await probe({
    uri: uri(review),
    ...greetAt,
    feature: definition,
    open: true,
  });

  assert.equal(unavailable.result?.length ?? 0, 0);
  await writeFile(
    path.join(headEnvironment.rootPath, "main.ts"),
    managedMain.replace("export const value = greet();\r\n", ""),
  );

  const deletedLine = await probe({
    uri: uri(review),
    ...greetAt,
    feature: definition,
    open: true,
  });

  assert.equal(deletedLine.result?.length ?? 0, 0);
  await writeFile(
    path.join(headEnvironment.rootPath, "main.ts"),
    "// another shift\n" + managedMain,
  );

  for (const feature of [
    definition,
    "vscode.executeHoverProvider",
    "vscode.executeReferenceProvider",
    "vscode.executeTypeDefinitionProvider",
    "vscode.executeImplementationProvider",
  ]) {
    const result = await probe({
      uri: uri(review),
      ...greetAt,
      feature,
      open: true,
    });

    assert.equal(
      result.result?.length ?? 0,
      0,
      `${feature} must reject a file with shifted contents`,
    );
  }

  await record(
    "changed or shifted source files suppress language queries, including unchanged lines",
  );

  await writeFile(path.join(headEnvironment.rootPath, "main.ts"), managedMain);
  // Only mutate the disposable fixture: test changing branches with Review still open.
  await git(first.repo, "reset", "--hard", first.head);
  await git(first.repo, "checkout", "--detach", first.base);
  await expectDefinition(
    uri(review),
    greetAt,
    uri(review, "head", "library.ts"),
    2,
  );
  await git(first.repo, "checkout", "main");
  await expectDefinition(
    uri(review),
    greetAt,
    uri(review, "head", "library.ts"),
    2,
  );
  await record(
    "branch changes do not repin review content or change pinned LSP",
  );

  const renamed = await probe({
    uri: uri(review, "base", "old.ts"),
    line: 0,
    character: 25,
    feature: definition,
    open: true,
  });

  assert.ok(
    locations(renamed.result).some(
      (item) => locationUri(item.uri) === uri(review, "base", "library.ts"),
    ),
  );
  await expectDefinition(
    uri(review, "head", "renamed.ts"),
    { line: 0, character: 25 },
    uri(review, "head", "library.ts"),
    2,
  );

  for (const source of [
    uri(review, "base", "deleted.ts"),
    `${uri(review, "base", "added.ts")}&empty=true`,
    `${uri(review, "head", "deleted.ts")}&empty=true`,
  ]) {
    const result = await probe({
      uri: source,
      line: 0,
      character: 1,
      feature: definition,
      open: true,
    });

    assert.equal(result.result?.length ?? 0, 0);
  }

  await record(
    "renamed/missing paths and empty added/deleted sides never select a substitute",
  );
  await expectDefinition(
    uri(review, "head", "main.ts", first.head),
    greetAt,
    uri(review, "head", "library.ts", first.head),
    2,
  );
  await record("selected-commit source retains its own pinned coordinates");

  const newerPins = await api("/pins", "POST", {
    repositoryId: review.pins.repositoryId,
    base: first.base,
    head: first.base,
  });

  await command({ type: "repin", reviewId: review.reviewId, pins: newerPins });
  const newerReview = await api(`/${review.reviewId}?full=true`);
  const historical = await expectHover(uri(review), greetAt, "string");
  assert.equal(historical.active.text, mainText("head"));
  const repinned = await expectHover(uri(newerReview), greetAt, "string");
  assert.equal(repinned.active.text, mainText("base"));
  await command({
    type: "restore",
    reviewId: review.reviewId,
    version: review.version,
  });
  await record(
    "historical saved versions keep their source after repin and restore",
  );

  await probe({
    uri: uri(review),
    ...greetAt,
    open: true,
    command: "editor.action.revealDefinition",
  });

  const navigated = await until(async () => {
    const state = await probe({});

    return (
      locationUri(state.active?.uri) === uri(review, "head", "library.ts") &&
      state
    );
  }, "rendered definition target");

  assert.equal(
    locationUri(navigated.active.uri),
    uri(review, "head", "library.ts"),
  );
  assert.equal(navigated.active.line, 2);
  await page.screenshot({ path: path.join(root, "definition-target.png") });
  await record(
    "real Go to Definition stays in the saved review version and side",
  );

  await probe({ command: "workbench.action.closeModalEditor" });
  await api(`/${review.reviewId}/open`, "POST");
  await until(async () => {
    await page
      .locator(".review-canvas-root")
      .filter({ hasText: "Local LSP regression" })
      .first()
      .waitFor({ timeout: 3000 });

    return true;
  }, "reopened review");
  const restoredReview = await api(`/${review.reviewId}?full=true`);

  if (structuralDiffAvailable) {
    // Document code views use the native unified diff editor. The modified
    // editor owns the rendered surface; base-side LSP behavior is covered by
    // the API probes above.
    for (const side of ["head"]) {
      const editorSide = "modified";
      const lineText = "export const value = greet();";

      const inline = page
        .locator(
          `[data-review-diff-path="main.ts"] .monaco-diff-editor .editor.${editorSide}`,
        )
        .filter({
          has: page.locator(".view-line").filter({ hasText: lineText }),
        })
        .first();

      const line = inline
        .locator(".view-line")
        .filter({ hasText: lineText })
        .first();

      await until(async () => {
        await line.scrollIntoViewIfNeeded({ timeout: 2000 });
        await clickGreet(line);

        return true;
      }, "inline source mounted");
      await probe({ command: "editor.action.showHover" });
      await page
        .locator(".monaco-hover:visible")
        .filter({ hasText: "greet" })
        .first()
        .waitFor();
      await page.screenshot({
        path: path.join(root, `inline-${side}-hover.png`),
      });
      await page.keyboard.press("Escape");
    }

    await page.keyboard.press("F12");
    await until(
      async () =>
        locationUri((await probe({})).active?.uri) ===
        uri(restoredReview, "head", "library.ts"),
      "inline definition navigation",
    );
    await record(
      "rendered inline peeks show local hover and navigate to definitions",
    );
  } else {
    console.log("SKIP rendered inline peeks: diffr is unavailable on PATH");
  }

  await probe({ diff: { base: uri(review, "base"), head: uri(review) } });

  for (const side of ["original", "modified"]) {
    const line = page
      .locator(
        `.monaco-modal-editor-block .monaco-diff-editor:visible .editor.${side} .view-line`,
      )
      .filter({ hasText: "export const value = greet();" })
      .first();

    await line.scrollIntoViewIfNeeded();
    await clickGreet(line);
    await probe({ command: "editor.action.showHover" });
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "greet" })
      .first()
      .waitFor();
    await page.screenshot({ path: path.join(root, `diff-${side}-hover.png`) });
    await probe({ command: "editor.action.hideHover" });
    await until(
      async () => (await page.locator(".monaco-hover:visible").count()) === 0,
      "previous pane hover dismissed",
    );
  }

  await record("rendered full-file diff supports language hover on both sides");

  await stop();
  await launch();
  await expectDefinition(
    uri(review),
    greetAt,
    uri(review, "head", "library.ts"),
    2,
  );
  await expectDefinition(
    uri(review, "head", "main.py"),
    { line: 2, character: 9 },
    uri(review, "head", "library_py.py"),
    0,
  );
  await record("Desktop restart restores language-service context");
  await expectDefinition(
    uri(other),
    greetAt,
    uri(other, "head", "library.ts"),
    2,
  );
  await rename(second.repo, `${second.repo}-missing`);

  const missing = await probe({
    uri: uri(other),
    ...greetAt,
    feature: definition,
    open: true,
  });

  assert.equal(missing.result?.length ?? 0, 0);
  await rename(`${second.repo}-missing`, second.repo);
  await expectDefinition(
    uri(other),
    greetAt,
    uri(other, "head", "library.ts"),
    2,
  );
  await record(
    "missing worktree disables language queries and recovers when restored",
  );

  for (const fix of [first, second]) {
    const paths = (await git(fix.repo, "worktree", "list", "--porcelain"))
      .split("\n")
      .filter((line) => line.startsWith("worktree "));

    assert.ok(paths.includes(`worktree ${fix.repo}`));
    assert.ok(paths.length > 1);
    assert.ok(
      paths
        .filter((item) => item !== `worktree ${fix.repo}`)
        .every((item) => item.includes("/.git/dev-fast/reviews/")),
    );
  }

  await record("commit reviews reuse only their managed pinned worktrees");
  const precision = await fixture("precision");
  await writeFile(
    path.join(precision.repo, "library.ts"),
    libraryText("number", "42"),
  );
  await writeFile(
    path.join(precision.repo, "library_py.py"),
    "def greet() -> int:\n    return 42\n",
  );
  await git(precision.repo, "add", ".");
  await git(precision.repo, "commit", "-qm", "Different historical types");
  precision.head = await git(precision.repo, "rev-parse", "HEAD");
  const exact = await createReview(precision, "Historical project semantics");
  await readyEnvironment(exact);
  await readyEnvironment(exact, "base");

  for (const [side, type, dependency, python] of [
    ["base", "string", "installed", "str"],
    ["head", "number", "number", "int"],
  ]) {
    await expectHover(uri(exact, side), greetAt, type);
    await expectHover(
      uri(exact, side),
      at(mainText("head"), 6, "dependencyValue"),
      dependency,
    );
    await expectHover(
      uri(exact, side, "main.py"),
      { line: 2, character: 9 },
      python,
    );
  }

  await record(
    "base/head TypeScript, Python and prepared dependencies use matching historical environments",
  );
  await git(
    precision.repo,
    "config",
    "--add",
    "devfast.prepare",
    `node -e 'const fs=require("node:fs");const p="main.ts";fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("export const value = greet();","export const value = service.run();"))'`,
  );
  await readyEnvironment(exact);

  const modifiedBySetup = await probe({
    uri: uri(exact),
    ...greetAt,
    feature: definition,
    open: true,
  });

  assert.equal(modifiedBySetup.result?.length ?? 0, 0);
  await record(
    "changed preparation invalidates cached models and suppresses changed source positions",
  );
  await git(
    precision.repo,
    "config",
    "--replace-all",
    "devfast.prepare",
    "echo fixture-preparation-failed; exit 7",
  );

  const failedPreparation = await until(async () => {
    const environment = await api(
      `/${exact.reviewId}/language-context?side=head&version=${exact.version}`,
    );

    const environments = await api(`/${exact.reviewId}/workspaces`);

    return environments.find(
      (item) =>
        item.generation === environment.identity && item.state === "failed",
    );
  }, "preparation failure");

  await probe({ command: "workbench.action.closeModalEditor" });
  const opened = await api(`/${exact.reviewId}/open`, "POST");
  assert.equal(opened.environmentIssues, undefined);
  assert.deepEqual(await api(`/${exact.reviewId}/environment`, "POST", {}), {
    issues: [],
  });
  assert.equal(
    await page
      .getByText("Language environment needs attention", { exact: true })
      .count(),
    0,
  );
  await git(
    precision.repo,
    "config",
    "--replace-all",
    "devfast.prepare",
    "node prepare.cjs",
  );
  await api(
    `/${exact.reviewId}/workspaces/${failedPreparation.id}/retry`,
    "POST",
  );
  await readyEnvironment(exact);
  await record(
    "failed preparation with a usable checkout stays silent and can retry",
  );
  const liveFixture = await fixture("live");

  const live = await createReview(
    liveFixture,
    "Working tree language services",
    "worktree",
  );

  const repositoryId = live.pins.repositoryId;

  const liveTreesBefore = await git(
    liveFixture.repo,
    "worktree",
    "list",
    "--porcelain",
  );

  await probe({ command: "workbench.action.closeModalEditor" });
  await api(`/${live.reviewId}/open`, "POST");

  if (structuralDiffAvailable) {
    const liveInline = page
      .locator(
        '[data-review-diff-path="main.ts"] .monaco-diff-editor .editor.modified',
      )
      .filter({
        has: page
          .locator(".view-line")
          .filter({ hasText: "export const value = greet();" }),
      })
      .first();

    const liveLine = liveInline
      .locator(".view-line")
      .filter({ hasText: "export const value = greet();" })
      .first();

    await until(async () => {
      await liveLine.scrollIntoViewIfNeeded({ timeout: 2000 });
      await clickGreet(liveLine);

      return true;
    }, "live inline source");
    await probe({ command: "editor.action.showHover" });
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "greet" })
      .first()
      .waitFor();
    assert.ok(
      !(
        await page.locator(".monaco-hover:visible").first().innerText()
      ).includes("Language information from local checkout"),
    );
    await probe({ command: "editor.action.hideHover" });
    await clickGreet(liveLine);
    await probe({ command: "type", args: [{ text: "should not edit peek" }] });
    assert.equal(
      await readFile(path.join(liveFixture.repo, "main.ts"), "utf8"),
      mainText("head"),
    );
    await page.keyboard.press("F12");
    await until(
      async () =>
        locationUri((await probe({})).active?.uri) ===
        uri(live, "head", "library.ts"),
      "live inline definition",
    );
    await expectHover(
      pathToFileURL(path.join(liveFixture.repo, "main.py")).href,
      { line: 2, character: 9 },
      "str",
    );
    await record(
      "worktree JSON review uses real native TypeScript and Python language services",
    );
  } else {
    console.log("SKIP live inline peeks: diffr is unavailable on PATH");
  }

  const workspaceLibrary = pathToFileURL(
    path.join(liveFixture.repo, "library.ts"),
  ).href;

  await probe({
    uri: workspaceLibrary,
    open: true,
    edit: { uri: workspaceLibrary, text: "// unsaved destination\n" },
  });

  const dirtyDestination = await probe({
    uri: uri(live),
    ...greetAt,
    feature: definition,
    open: true,
  });

  assert.equal(
    dirtyDestination.result.length,
    0,
    "unsaved destination coordinates cannot navigate into a saved buffer",
  );
  await probe({ uri: workspaceLibrary, open: true });
  assert.ok((await probe({})).active.text.startsWith("// unsaved destination"));
  await probe({ command: "workbench.action.files.revert" });

  const workspaceMain = pathToFileURL(
    path.join(liveFixture.repo, "main.ts"),
  ).href;

  const unsaved = "// workspace buffer\r\n" + mainText("head");
  await probe({
    uri: workspaceMain,
    open: true,
    edit: { uri: workspaceMain, text: "// workspace buffer\r\n" },
  });
  assert.equal((await probe({})).active.text, unsaved);

  for (const diff of [false, true]) {
    if (diff)
      await probe({ diff: { base: uri(live, "base"), head: uri(live) } });
    else await probe({ uri: uri(live), open: true });
    assert.equal((await probe({})).active.text, mainText("head"));

    for (const [command, args] of [
      ["type", [{ text: "forbidden" }]],
      [
        "paste",
        [{ text: "forbidden", pasteOnNewLine: false, multicursorText: null }],
      ],
      ["editor.action.formatDocument", []],
      ["editor.action.quickFix", []],
      ["workbench.action.files.save", []],
      ["workbench.action.files.saveAs", []],
    ]) {
      await probe({ command, args });
      assert.equal((await probe({})).active.text, mainText("head"), command);
    }

    assert.equal(
      (await probe({ edit: { uri: workspaceMain, text: "forbidden" } })).result,
      false,
    );
    assert.equal(
      (await probe({ edit: { uri: uri(live), text: "forbidden" } })).result,
      false,
    );
    assert.equal(
      await readFile(path.join(liveFixture.repo, "main.ts"), "utf8"),
      mainText("head"),
    );
  }

  await probe({ uri: workspaceMain, open: true });
  assert.equal((await probe({})).active.uri, workspaceMain);
  assert.equal((await probe({})).active.text, unsaved);
  assert.equal((await probe({})).active.dirty, true);
  await probe({ command: "workbench.action.files.revert" });
  await probe({ uri: uri(live), open: true });
  await writeFile(path.join(liveFixture.repo, "main.ts"), unsaved);
  await until(
    async () => (await probe({})).active.text === unsaved,
    "review follows external saved edits",
  );
  await page.screenshot({ path: path.join(root, "readonly-source.png") });
  await writeFile(path.join(liveFixture.repo, "main.ts"), mainText("head"));
  await until(
    async () => (await probe({})).active.text === mainText("head"),
    "review disk refresh",
  );
  await record(
    "review source, diff and peek block edits, preserve dirty workspace buffers and follow external saves",
  );

  let environmentRequests = 0;

  const countEnvironment = (request) => {
    if (request.url().includes(`/${live.reviewId}/language-context?`))
      environmentRequests++;
  };

  await expectHover(uri(live), greetAt, "string");
  page.on("request", countEnvironment);

  try {
    // Late file notifications from the preceding save/revert may correctly
    // reject a wave. Measure a completed wave once those changes settle.
    await until(async () => {
      environmentRequests = 0;

      const repeated = await probe({
        uri: uri(live),
        ...greetAt,
        feature: hover,
        repeat: 20,
        open: true,
      });

      return repeated.result.length >= 20;
    }, "concurrent native hovers after file refresh");
    assert.ok(
      environmentRequests >= 2 && environmentRequests < 40,
      `expected overlapping providers to share requests (fewer than 40); got ${environmentRequests}`,
    );
    console.log(
      `20 concurrent native hovers used ${environmentRequests} environment requests (uncoalesced: 40).`,
    );
  } finally {
    page.off("request", countEnvironment);
  }

  const delayed = probe({
    uri: uri(live),
    ...greetAt,
    feature: hover,
    delayedHover: true,
    open: true,
  });

  const movedLive = `${liveFixture.repo}-pending-query`;
  await until(
    async () => readFile(path.join(root, "provider-started"), "utf8"),
    "delayed language provider",
  );
  await rename(liveFixture.repo, movedLive);

  try {
    await writeFile(path.join(root, "provider-release"), "release");
    assert.equal(
      (await delayed).result.length,
      0,
      "removed environment must reject the delayed hover",
    );
  } finally {
    await rename(movedLive, liveFixture.repo);
  }

  await expectHover(uri(live), greetAt, "string");
  await record(
    "concurrent native hovers coalesce environment reads and delayed results are rejected after checkout removal",
  );
  await writeFile(
    path.join(liveFixture.repo, "library.ts"),
    "// shifted locally\n" + libraryText("number", "42"),
  );
  await expectHover(uri(live), greetAt, "number");
  await expectDefinition(
    uri(live),
    greetAt,
    uri(live, "head", "library.ts"),
    3,
  );
  await writeFile(
    path.join(liveFixture.repo, "main.ts"),
    "// unrelated local edit\n" + mainText("head"),
  );
  // A historical authored version opens the same live checkout and gets LSP
  // at its current coordinates; authored references themselves do not move.
  await expectDefinition(
    pathToFileURL(path.join(liveFixture.repo, "main.ts")).href,
    at("// unrelated local edit\n" + mainText("head"), 4, "greet"),
    path.join(liveFixture.repo, "library.ts"),
    3,
  );
  await writeFile(path.join(liveFixture.repo, "main.ts"), mainText("head"));
  await writeFile(
    path.join(liveFixture.repo, "library.ts"),
    libraryText("string", JSON.stringify("live")),
  );

  const liveTreesAfter = await git(
    liveFixture.repo,
    "worktree",
    "list",
    "--porcelain",
  );

  const liveTreeEntries = liveTreesAfter
    .split("\n")
    .filter((line) => line.startsWith("worktree "));

  assert.ok(liveTreeEntries.includes(`worktree ${liveFixture.repo}`));
  assert.ok(
    liveTreeEntries
      .filter((entry) => entry !== `worktree ${liveFixture.repo}`)
      .every((entry) => entry.includes("/.git/dev-fast/reviews/")),
  );
  assert.ok(
    (await api(`/${live.reviewId}/workspaces`)).every((workspace) =>
      workspace.rootPath.includes("/.git/dev-fast/reviews/"),
    ),
  );
  await assert.rejects(readFile(path.join(liveFixture.repo, ".prepare-count")));
  await record(
    "live worktree source and language services follow saved edits without preparation",
  );

  await probe({ command: "workbench.action.closeModalEditor" });
  await api(`/${live.reviewId}/open`, "POST");
  await writeFile(
    path.join(liveFixture.repo, "main.ts"),
    "// saved staged line\n" + mainText("head"),
  );
  await git(liveFixture.repo, "add", "main.ts");
  await writeFile(
    path.join(liveFixture.repo, "main.ts"),
    "// saved unstaged line\n// saved staged line\n" + mainText("head"),
  );
  await writeFile(
    path.join(liveFixture.repo, "fresh.ts"),
    "export const fresh = 1;\n",
  );
  await until(
    async () =>
      (
        await api(`/${live.reviewId}/file?side=head&file=main.ts`)
      ).text.startsWith("// saved unstaged line"),
    "saved worktree API bytes",
  );
  const updated = await api(`/${live.reviewId}?full=true`);
  assert.equal(updated.version, live.version);
  assert.equal(updated.document[0].children[2].source.start.line, 3);

  const historicalWorktree = await api(
    `/${live.reviewId}/file?side=head&file=main.ts&version=${live.version}`,
  );

  assert.equal(
    historicalWorktree.text,
    "// saved unstaged line\n// saved staged line\n" + mainText("head"),
  );
  assert.ok(
    (await api(`/${live.reviewId}/tree`)).some(
      (file) => file.path === "fresh.ts",
    ),
  );
  // This check targets the refreshed file's definition identity. The exact
  // line offset can vary while the live language model incorporates staged
  // and unstaged bytes.
  await expectDefinition(
    pathToFileURL(path.join(liveFixture.repo, "main.ts")).href,
    at(
      "// saved unstaged line\n// saved staged line\n" + mainText("head"),
      5,
      "greet",
    ),
    path.join(liveFixture.repo, "library.ts"),
  );
  await record(
    "staged, unstaged, and untracked saved files refresh while authored history stays fixed",
  );

  const whole = await command({
    type: "create",
    title: "Whole checkout",
    target: { kind: "worktree", repositoryId },
  });

  await git(liveFixture.repo, "add", ".");
  await git(liveFixture.repo, "commit", "-qm", "Current working files");
  await until(
    async () => (await api(`/${whole.reviewId}/diff`)).length === 0,
    "working changes baseline follows commit",
  );

  const single = await command({
    type: "create",
    title: "Single commit",
    target: { kind: "commits", repositoryId, head: "HEAD" },
  });

  assert.deepEqual(await api(`/${single.reviewId}/diff`), []);
  await git(liveFixture.repo, "checkout", "--detach", liveFixture.head);
  await until(
    async () =>
      (await api(`/${live.reviewId}/file?side=head&file=main.ts`)).text ===
      mainText("head"),
    "worktree follows branch switch",
  );
  assert.ok(
    (
      await api(`/${single.reviewId}/file?side=head&file=main.ts`)
    ).text.startsWith("// saved unstaged line"),
  );
  await record(
    "whole-worktree commit baseline and explicit commit target stay distinct across checkout changes",
  );
  await stop();
  await launch();
  await until(async () => {
    await api(`/${live.reviewId}/open`, "POST");

    return true;
  }, "reopen live review");
  const reopened = await api(`/${live.reviewId}?full=true`);

  await expectDefinition(
    uri(reopened),
    greetAt,
    uri(reopened, "head", "library.ts"),
    2,
  );
  assert.equal(
    (
      await api(
        `/${live.reviewId}/file?side=head&file=main.ts&version=${live.version}`,
      )
    ).text,
    mainText("head"),
  );

  const reopenedTrees = await git(
    liveFixture.repo,
    "worktree",
    "list",
    "--porcelain",
  );

  assert.ok(reopenedTrees.includes(`worktree ${liveFixture.repo}`));
  assert.ok(
    reopenedTrees
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .filter((entry) => entry !== `worktree ${liveFixture.repo}`)
      .every((entry) => entry.includes("/.git/dev-fast/reviews/")),
  );
  await page.screenshot({ path: path.join(root, "live-worktree-restart.png") });
  await record(
    "live worktree review and authored history recover after Desktop restart without pinning",
  );
  await probe({ command: "workbench.action.closeModalEditor" });
  await mkdir(path.join(liveFixture.repo, "nested"));
  await writeFile(
    path.join(liveFixture.repo, "nested/child.ts"),
    "export const child = 1;\n",
  );

  const homeReview = await createReview(
    liveFixture,
    "Home live source",
    "worktree",
  );

  await page.getByRole("tab", { name: /^Home/ }).first().click();
  await page.getByRole("button", { name: /^Home live source/ }).click();
  await page
    .getByRole("button", { name: "Source tree ↗", exact: true })
    .click();
  await page
    .getByRole("tab", { name: new RegExp(`^Source — ${homeReview.title}$`) })
    .waitFor();
  await writeFile(
    path.join(liveFixture.repo, "from-home.ts"),
    "export const fromHome = 1;\n",
  );
  await page.getByText("from-home.ts", { exact: true }).first().waitFor();
  await page.getByText("nested", { exact: true }).first().click();
  await page.keyboard.press("ArrowRight");
  await page.getByText("child.ts", { exact: true }).first().waitFor();
  await command({
    type: "rename",
    reviewId: homeReview.reviewId,
    title: "Renamed live source",
  });
  await writeFile(
    path.join(liveFixture.repo, "nested/second.ts"),
    "export const second = 2;\n",
  );
  await page.getByText("second.ts", { exact: true }).first().waitFor();
  // Opening a refreshed child must not replace the current Source root with
  // that file's resolved revision or collapse its already-expanded directory.
  await page.getByText("second.ts", { exact: true }).first().dblclick();
  await page.getByText("child.ts", { exact: true }).first().waitFor();
  await writeFile(
    path.join(liveFixture.repo, "nested/third.ts"),
    "export const third = 3;\n",
  );
  await page.getByText("third.ts", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(root, "home-live-source.png") });
  await record(
    "Source opened through a Home review stays live and preserves expanded folders across authored versions",
  );
  assert.deepEqual(errors, []);
  success = true;
} finally {
  if (page && !success) {
    await page
      .screenshot({ path: path.join(root, "failure.png") })
      .catch(() => {});
    await writeFile(
      path.join(root, "failure-dom.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }

  await writeFile(path.join(root, "app.log"), appLog);
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify({ root, success, checks, errors }, null, 2),
  );
  await stop();
  console.log(JSON.stringify({ root, success, checks }));

  if (success && !values.keep) await rm(root, { recursive: true, force: true });
}
