/** Real CLI -> server -> Desktop rendering gate, with isolated stores/profiles.
 * Run after building Desktop and staging a production Review package:
 * node scripts/native-authoring-e2e.mjs --runtime /absolute/production-package
 * Add --app /absolute/Review.app to exercise the packaged application.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { assertRuntimeContents } from "./stage-review-runtime.mjs";

const exec = promisify(execFile);

const appRoot = path.resolve(import.meta.dirname, "..");

const workspace = path.resolve(appRoot, "../..");

const sourcePackage = path.join(workspace, "packages/review");

const require = createRequire(path.join(appRoot, "code-oss/package.json"));

const { chromium } = require("playwright-core");

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    app: { type: "string" },
    keep: { type: "boolean", default: false },
    "baseline-runtime": { type: "string" },
    "comparison-runtime": { type: "string" },
    // Only reuse completed rows from the same runtimes and unchanged corpus.
    "resume-benchmark": { type: "string" },
  },
});

assert.ok(
  values.runtime,
  "--runtime must name a production-installed Review package",
);

const runtime = await realpath(values.runtime);

await assertRuntimeContents(runtime);

const root = await realpath(
  await mkdtemp(
    path.join(
      process.platform === "darwin" ? "/tmp" : os.tmpdir(),
      "review-e2e-",
    ),
  ),
);

const home = path.join(root, "home");

const repo = path.join(root, "repo");

await mkdir(repo);

const env = {
  ...process.env,
  DEV_REVIEW_HOME: home,
  DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
  DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
  DEV_REVIEW_EXTENSIONS: "none",
};

for (const key of [
  "DEV_FAST_AGENT_SESSION",
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "PI_SESSION_ID",
  "DEV_FAST_REVIEW_TOOLING_ROOT",
  "NODE_OPTIONS",
])
  delete env[key];

const git = async (...args) =>
  (await exec("git", args, { cwd: repo, env })).stdout.trim();

await git("init", "-q", "-b", "main");

await git("config", "user.name", "Review E2E");

await git("config", "user.email", "review-e2e@example.invalid");

await writeFile(
  path.join(repo, "order.ts"),
  'export const status = "draft";\n',
);

await git("add", ".");

await git("commit", "-qm", "Draft");

const base = await git("rev-parse", "HEAD");

await writeFile(
  path.join(repo, "order.ts"),
  'export const status = "queued";\n',
);

await git("commit", "-qam", "Queue");

const head = await git("rev-parse", "HEAD");

const legacyRoot = path.join(sourcePackage, "src/fixtures/legacy-reviews");

const legacyFixtures = [];

// Extracted only after the Desktop attaches, so `app pick` exercises
// import-on-open rather than the Home sweep.
const DEFERRED_FIXTURE = "schema4-bug-report-dialog";

async function extractFixture(fixture) {
  const { name, metadata } = fixture;
  const legacyDir = path.join(home, "reviews", metadata.sourceUuid);
  await mkdir(legacyDir, { recursive: true });
  await exec("tar", [
    "-xzf",
    path.join(legacyRoot, `${name}.tgz`),
    "-C",
    legacyDir,
  ]);
  let worktreePath = repo;

  if (metadata.sourceRepository === "devdotfast/review") {
    worktreePath = path.join(root, name);
    await exec("git", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      workspace,
      worktreePath,
    ]);
    await exec("git", [
      "-C",
      worktreePath,
      "fetch",
      "--quiet",
      workspace,
      metadata.baseCommit,
      metadata.sourceCommit,
    ]);
  }

  const legacyRecordPath = path.join(legacyDir, "review.json");
  const original = JSON.parse(await readFile(legacyRecordPath, "utf8"));
  await writeFile(
    legacyRecordPath,
    JSON.stringify({ ...original, worktreePath }),
  );
  Object.assign(fixture, {
    legacyDir,
    worktreePath,
    legacyRecordPath,
    original,
  });
}

for (const archive of (await readdir(legacyRoot))
  .filter((name) => name.endsWith(".tgz"))
  .sort()) {
  const name = archive.slice(0, -4);

  const metadata = JSON.parse(
    await readFile(path.join(legacyRoot, `${name}.json`), "utf8"),
  );

  const fixture = { name, metadata, deferred: name === DEFERRED_FIXTURE };

  if (!fixture.deferred) await extractFixture(fixture);
  legacyFixtures.push(fixture);
}

const portServer = createServer();

await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));

const port = portServer.address().port;

await new Promise((resolve) => portServer.close(resolve));

env.DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT = String(port);

const profile = path.join(home, "review-desktop/state");

await mkdir(path.join(profile, "user-data/User"), { recursive: true });

await writeFile(
  path.join(profile, "user-data/User/settings.json"),
  JSON.stringify({
    "review.experimental.softwareMap.enabled": true,
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
  }),
);

const launchArgs = values.app
  ? [
      "--disable-telemetry",
      "--skip-welcome",
      `--user-data-dir=${profile}/user-data`,
      `--extensions-dir=${profile}/extensions`,
      `--remote-debugging-port=${port}`,
    ]
  : [path.join(appRoot, "scripts/run.sh")];

const app = spawn(
  values.app ? path.join(values.app, "Contents/MacOS/Review") : "bash",
  launchArgs,
  { cwd: appRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);

let appLog = "";

function lifecycle(message) {
  appLog += `\n[E2E ${new Date().toISOString()}] ${message}\n`;
}

app.on("exit", (code, signal) => lifecycle(`Desktop exit: ${code}, ${signal}`));

app.stdout.on("data", (chunk) => {
  appLog = (appLog + chunk).slice(-200000);
});

app.stderr.on("data", (chunk) => {
  appLog = (appLog + chunk).slice(-200000);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(run, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let error;

  while (Date.now() < deadline) {
    try {
      const result = await run();

      if (result) return result;
    } catch (caught) {
      error = caught;
    }

    if (app.exitCode !== null)
      throw new Error(
        `Desktop exited (${app.exitCode}): ${appLog.slice(-5000)}`,
      );
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for ${label}: ${error?.message ?? "not ready"}`,
  );
}

let browser;

let page;

const pageErrors = [];

async function watchPage(candidate) {
  candidate.on("pageerror", (error) => pageErrors.push(error.message));
  candidate.on("close", () => lifecycle("Workbench page closed"));
  // New workbench windows can show the isolated profile's community invitation.
  await candidate.addLocatorHandler(
    candidate.getByText("Join the Review community", { exact: true }),
    async () => {
      await candidate
        .getByRole("checkbox", { name: "Don't show again" })
        .check();
      await candidate
        .getByRole("button", { name: "Not now", exact: true })
        .click();
    },
  );
}

const report = {
  mode: values.app ? "packaged" : "development",
  runtime,
  root,
  checks: [],
};

let success = false;

try {
  const discovery = await until(async () => {
    const value = JSON.parse(
      await readFile(path.join(home, "review-desktop/server.json"), "utf8"),
    );

    const health = await (await fetch(`${value.url}/health`)).json();

    return health.ok && health.desktopAttached ? value : null;
  }, "attached Desktop server");

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browser.on("disconnected", () => lifecycle("Desktop CDP disconnected"));
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes("workbench")),
    "workbench renderer",
  );
  await watchPage(page);

  const api = async (route, method = "GET", body) => {
    const response = await fetch(new URL(route, discovery.url), {
      method,
      headers: {
        "x-review-token": discovery.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, value: await response.json() };
  };

  const stripIds = (value) =>
    Array.isArray(value)
      ? value.map(stripIds)
      : value?.constructor === Object
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "id")
              .map(([key, child]) => [key, stripIds(child)]),
          )
        : value;

  // The JSON canvas for a review; a legacy canvas may still be mounted elsewhere.
  const apiCanvasFor = (title) =>
    until(async () => {
      for (const candidate of browser
        .contexts()
        .flatMap((context) => context.pages()))
        if (
          (await candidate
            .locator(".review-canvas-root [data-review-api]")
            .count()
            .catch(() => 0)) > 0 &&
          (await candidate
            .getByRole("heading", { name: title, exact: true })
            .isVisible()
            .catch(() => false))
        )
          return candidate;

      return null;
    }, `JSON canvas for ${title}`);

  // Listing Home starts the sweep, which is how the Desktop imports too.
  const waitForImport = (reviewId) =>
    until(async () => {
      await api("/reviews");
      const snapshot = await api(`/reviews-api/${reviewId}?full=true`);

      return snapshot.status === 200 ? snapshot.value : null;
    }, `${reviewId} imported`);

  const expectMigratedError = (events) =>
    assert.ok(
      events.some(
        (event) =>
          event.event === "error" &&
          [...(event.diagnostics ?? []), event.message ?? ""].some((text) =>
            /migrated to the JSON review store/.test(text),
          ),
      ),
      JSON.stringify(events),
    );

  async function cli(args, expectedCode = 0, cwd = repo) {
    // Reload temporarily detaches Desktop. Wait before app pick can interpret
    // that gap as a reason to launch the system-installed application.
    if (args[0] === "app" && args[1] === "pick") {
      await until(async () => {
        const health = await (await fetch(`${discovery.url}/health`)).json();

        return health.ok && health.desktopAttached;
      }, "fixture Desktop reattachment");
    }

    let result;

    try {
      result = {
        ...(await exec(
          process.execPath,
          [path.join(runtime, "dist/cli.js"), ...args, "--json"],
          { cwd, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
        )),
        code: 0,
      };
    } catch (error) {
      result = {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: error.code,
      };
    }

    assert.equal(
      result.code,
      expectedCode,
      `${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
    );

    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  }

  console.log("Desktop attached; exercising installed CLI", root);

  const scaffold = (
    await cli(["scaffold", "--base", base, "--head", head])
  ).find((event) => event.reviews?.length);

  assert.ok(scaffold, "Scaffold must return a Review binding");
  const { uuid, dir } = scaffold.reviews[0];
  const helperCheckDir = path.join(root, "helper-check");
  await mkdir(helperCheckDir);
  await writeFile(path.join(helperCheckDir, "review.mdx"), "# Helper checks\n");
  const checkedHelper = path.join(helperCheckDir, "unimported.ts");
  await writeFile(checkedHelper, 'export const value: number = "wrong";\n');

  const checkHelpers = () =>
    exec(
      process.execPath,
      [path.join(runtime, "dist/cli.js"), "internal-test", helperCheckDir],
      { cwd: helperCheckDir, env, timeout: 60000 },
    );

  const expectHelperTypeError = () =>
    assert.rejects(checkHelpers(), (error) => {
      const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      assert.match(output, /unimported\.ts/);
      assert.match(output, /TS2322/);

      return true;
    });

  await expectHelperTypeError();
  await writeFile(
    path.join(helperCheckDir, "review.mdx"),
    'import { value } from "./unimported.js";\n\n# Helper checks\n\n{value}\n',
  );
  await expectHelperTypeError();
  await writeFile(checkedHelper, "export const value: number = 1;\n");
  await checkHelpers();
  report.checks.push(
    "installed internal-test rejects imported and unimported helper type errors and succeeds after correction",
  );

  const source = (
    await readFile(
      path.join(sourcePackage, "src/fixtures/document-json/order-review.mdx"),
      "utf8",
    )
  ).replace(
    'label="Read status" anchor={anchors.current}',
    'label="Read status" anchor={anchors.previous}',
  );

  const gfm =
    "\n\nA footnote[^note] and <kbd>Enter</kbd>.\n\n[^note]: Native pipeline footnote.\n";

  await cp(
    path.join(sourcePackage, "src/fixtures/document-json/data.ts.txt"),
    path.join(dir, "data.ts"),
  );
  await writeFile(
    path.join(dir, "label-types.ts"),
    "export interface Label { text: string }\n",
  );

  const labelSource = (text) =>
    'import { Label } from "./label-types.js";\n' +
    `const value: Label = { text: ${JSON.stringify(text)} };\n` +
    "export const label = value.text;\n";

  await writeFile(
    path.join(dir, "label.ts"),
    labelSource("Before helper edit"),
  );

  const authored =
    'import { label } from "./label.js";\n' +
    source +
    "\n\n<CodePeek anchor={anchors.current} />\n\n{label}\n" +
    gfm;

  const recordPath = path.join(dir, "review.json");

  // E1: publish errors before any successful publish import nothing.
  await writeFile(
    path.join(dir, "review.mdx"),
    authored + "\n\n<ReviewSection title={123}>Invalid</ReviewSection>\n",
  );
  const errors = await cli(["publish", "--review", uuid], 1);
  assert.ok(
    errors.some(
      (event) =>
        event.event === "error" && event.file && event.line && event.column,
    ),
  );
  assert.equal(
    JSON.parse(await readFile(recordPath, "utf8")).presentedDocumentRevision,
    null,
  );
  assert.equal(
    (await api(`/reviews-api/${uuid}`)).status,
    404,
    "failed publish does not import",
  );
  await writeFile(
    path.join(dir, "broken.tsx"),
    "export const label = <strong>broken;",
  );
  await writeFile(
    path.join(dir, "review.mdx"),
    authored.replace("./label.js", "./broken.tsx"),
  );
  const helperErrors = await cli(["publish", "--review", uuid], 1);
  assert.ok(
    helperErrors.some(
      (event) =>
        event.event === "error" &&
        event.file?.endsWith("broken.tsx") &&
        event.line === 1 &&
        event.column > 0,
    ),
    JSON.stringify(helperErrors),
  );
  assert.equal(
    (await api(`/reviews-api/${uuid}`)).status,
    404,
    "failed publish does not import",
  );
  await writeFile(path.join(dir, "review.mdx"), authored);
  await rm(path.join(dir, "broken.tsx"));
  console.log("E2E checkpoint", report.checks.length);
  report.checks.push("positioned publish errors import nothing");

  // E2, E3: the first successful publish is the handoff into the JSON store.
  const published = (await cli(["publish", "--review", uuid])).find(
    (event) => event.event === "published",
  );

  assert.ok(published?.revision);
  const snapshotA = await waitForImport(uuid);
  assert.equal(snapshotA.version, 0);
  page = await apiCanvasFor("Order persistence — café ☕");
  await watchPage(page);
  let canvas = page.locator(".review-canvas-root");
  await canvas.getByText("Before helper edit", { exact: false }).waitFor();
  assert.equal(
    await canvas
      .locator("th")
      .nth(1)
      .evaluate((element) => getComputedStyle(element).textAlign),
    "right",
  );
  await canvas.locator("a[data-footnote-ref]").click();
  await canvas
    .getByText("Native pipeline footnote.", { exact: false })
    .waitFor();
  await canvas
    .getByRole("button", { name: "Expand Storage details", exact: true })
    .click();
  await canvas
    .getByRole("combobox")
    .filter({ has: page.locator("option", { hasText: "Persist an order" }) })
    .waitFor();
  assert.doesNotMatch(await canvas.innerText(), /Layout failed:/);
  assert.match(await page.locator("body").innerText(), /draft/);
  console.log("E2E checkpoint", report.checks.length);
  report.checks.push(
    "first publish imports and renders in the JSON canvas",
    "JSON canvas renders tables, footnotes, peeks and DatabaseLens from the imported document",
    "installed helpers resolve .js specifiers to TypeScript and elide ordinary interface imports",
  );

  // E4: a migrated review refuses every MDX verb that would republish it.
  const scaffoldB = (
    await cli(["scaffold", "--base", base, "--head", head, "--new"])
  ).find((event) => event.reviews?.length);

  assert.ok(scaffoldB, "Second scaffold must return a Review binding");
  const { uuid: uuidB, dir: dirB } = scaffoldB.reviews[0];
  await cp(
    path.join(sourcePackage, "src/fixtures/document-json/data.ts.txt"),
    path.join(dirB, "data.ts"),
  );
  await writeFile(path.join(dirB, "review.mdx"), source);

  for (const revision of [base, head]) {
    const opened = (await cli(["map", "open", revision])).find(
      (event) => event.event === "map-open",
    );

    assert.ok(opened?.scratch);
    await writeFile(
      opened.scratch,
      'import { defineSoftwareMap } from "@dev.fast/progressive-review/software-map-model";\nexport default defineSoftwareMap({systems: {orders: {label: "Order service", containers: {api: {label: "Order API", components: {handler: {label: "Order handler", coverage: {files: ["order.ts"]}}}}}}}});\n',
    );
    await cli(["map", "check", revision, "--review", uuidB]);
  }

  assert.ok(
    (await cli(["publish", "--review", uuidB])).find(
      (event) => event.event === "published",
    ),
  );
  await waitForImport(uuidB);
  expectMigratedError(await cli(["publish", "--review", uuidB], 1));
  expectMigratedError(await cli(["map", "publish", "--review", uuidB], 1));
  // Healthy artifacts make repair a local no-op; damage them so it reaches
  // the server and meets the guard.
  await rm(path.join(dirB, ".bundle/document"), {
    recursive: true,
    force: true,
  });
  await exec("git", ["add", "-A"], { cwd: dirB, env });
  await exec("git", ["commit", "-qm", "E2E damaged document artifact"], {
    cwd: dirB,
    env,
  });

  const damagedRevision = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: dirB, env })
  ).stdout.trim();

  const recordB = JSON.parse(
    await readFile(path.join(dirB, "review.json"), "utf8"),
  );

  await writeFile(
    path.join(dirB, "review.json"),
    JSON.stringify({ ...recordB, presentedDocumentRevision: damagedRevision }),
  );
  expectMigratedError(await cli(["repair", "--review", uuidB], 1));
  assert.ok(
    !(await api("/reviews")).value.reviews.some((row) => row.uuid === uuidB),
    "migrated review leaves the legacy list",
  );
  assert.equal(
    (await api(`/reviews-api/${uuidB}?full=true`)).value.version,
    0,
    "refused verbs create no versions",
  );
  console.log("E2E checkpoint", report.checks.length);
  report.checks.push(
    "a migrated review refuses publish, map publish and repair",
  );

  const benchmarkCases = [
    {
      name: "order",
      input: {
        reviewPath: path.join(dir, "review.mdx"),
        evidence: {
          head: { sourceRootPath: repo },
          base: {
            sourceRootPath: path.join(
              repo,
              ".git/dev-fast/reviews",
              uuid,
              "base",
              base,
            ),
          },
        },
      },
      cli: { uuid, cwd: repo },
    },
  ];

  for (const fixture of legacyFixtures) {
    if (fixture.deferred) await extractFixture(fixture);

    const {
      name,
      metadata,
      legacyDir,
      worktreePath,
      legacyRecordPath,
      original,
    } = fixture;

    await cli(["info", "--review", metadata.sourceUuid], 0, worktreePath);
    const migrated = JSON.parse(await readFile(legacyRecordPath, "utf8"));

    const golden = JSON.parse(
      await readFile(
        path.join(legacyRoot, `${name}.expected-document.json`),
        "utf8",
      ),
    );

    const sealed = await exec(
      "git",
      [
        "show",
        `${migrated.presentedDocumentRevision}:.bundle/document/review-document.json`,
      ],
      { cwd: legacyDir, maxBuffer: 8 * 1024 * 1024 },
    );

    assert.deepEqual(JSON.parse(sealed.stdout), golden);
    assert.equal(migrated.status, original.status);
    assert.equal(migrated.createdAt, original.createdAt);

    const revisions = Number(
      (
        await exec(
          "git",
          ["rev-list", "--count", migrated.presentedDocumentRevision],
          { cwd: legacyDir },
        )
      ).stdout.trim(),
    );

    if (metadata.sourceRepository !== "devdotfast/review") {
      // Its source repository is not on this machine and it is a system
      // review: it stays legacy.
      await api("/reviews");
      assert.equal(
        (await api(`/reviews-api/${metadata.sourceUuid}`)).status,
        404,
        `${name} without its repository stays legacy`,
      );
      // A system review (the tutorial) is never listed on Home; the legacy
      // verbs keep working on it.
      await cli(["repair", "--review", metadata.sourceUuid], 0, worktreePath);
      benchmarkCases.push({
        name,
        input: { reviewPath: path.join(legacyDir, "review.mdx") },
      });
      report.checks.push(
        `${name}: installed migration matches sealed JSON golden; unimportable review keeps legacy repair`,
      );
      console.log("E2E legacy fixture passed", name);
      continue;
    }

    // E5: the Home sweep imported the eager fixtures during startup, so this
    // `app pick` only routes to the JSON canvas. E8: the deferred fixture is
    // imported by this open.
    if (!fixture.deferred) await waitForImport(metadata.sourceUuid);
    await cli(
      ["app", "pick", "--review", metadata.sourceUuid],
      0,
      worktreePath,
    );
    const snapshot = await waitForImport(metadata.sourceUuid);

    // E6: the imported document matches the block golden.
    const blocksGolden = JSON.parse(
      await readFile(
        path.join(legacyRoot, `${name}.expected-blocks.json`),
        "utf8",
      ),
    );

    const document = snapshot.document;
    const withoutMap = metadata.hasMap ? document.slice(0, -1) : document;

    const withoutCallout =
      withoutMap[0]?.type === "callout" &&
      withoutMap[0].title === "Imported from the MDX review"
        ? withoutMap.slice(1)
        : withoutMap;

    assert.deepEqual(stripIds(withoutCallout), blocksGolden);

    if (metadata.hasMap) {
      assert.equal(document.at(-1).title, "Software map");
      assert.equal(
        document
          .at(-1)
          .children.filter((block) => block.type === "software_map").length,
        2,
      );
    }

    // E7: origin and history survive.
    assert.ok(
      snapshot.origin?.branch || snapshot.origin?.baseRef,
      `${name} carries origin`,
    );

    const history = await api(`/reviews-api/${metadata.sourceUuid}/history`);
    assert.equal(history.value.length, snapshot.version + 1);
    assert.ok(
      snapshot.version + 1 <= revisions,
      `${name}: ${snapshot.version + 1} versions from ${revisions} revisions`,
    );
    assert.ok(
      !(await api("/reviews")).value.reviews.some(
        (row) => row.uuid === metadata.sourceUuid,
      ),
      `${name} left the legacy list`,
    );

    // E9: the JSON canvas shows it.
    page = await apiCanvasFor(golden.title);
    await watchPage(page);
    canvas = page.locator(".review-canvas-root");

    if (metadata.hasMap) {
      // The imported map section starts collapsed.
      await canvas
        .getByRole("button", { name: "Expand Software map", exact: true })
        .click();
      await canvas.locator(".software-map").first().waitFor({ timeout: 30000 });
    }

    // E10: the JSON API rejects the pitfalls the render gate used to catch, and
    // accepts a valid block that then renders in the open canvas.
    const before = (await api(`/reviews-api/${metadata.sourceUuid}?full=true`))
      .value;

    const edit = (content) =>
      api("/reviews-api/commands", "POST", {
        commandId: randomUUID(),
        operation: {
          type: "edit",
          reviewId: metadata.sourceUuid,
          edit: { type: "insert", content },
        },
      });

    for (const [content, message] of [
      [
        {
          type: "database_lens",
          title: "Empty",
          actors: { app: "App" },
          stores: {},
          useCases: [],
        },
        "at least one store",
      ],
      [
        {
          type: "sequence",
          title: "Save",
          actors: { app: "App" },
          steps: [{ from: "app", to: "db", label: "Write", explanation: "x" }],
        },
        "Unknown component name: db",
      ],
      [
        {
          type: "code_peek",
          source: {
            side: "head",
            file: "../outside.ts",
            fromLine: 1,
            toLine: 1,
          },
        },
        "repository-relative",
      ],
    ]) {
      const rejected = await edit(content);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.value));
      assert.match(rejected.value.error, new RegExp(message));
    }

    const after = (await api(`/reviews-api/${metadata.sourceUuid}?full=true`))
      .value;

    assert.deepEqual(after, before, "rejected edits must not change the document");

    const accepted = await edit({
      type: "callout",
      title: "E2E marker",
      tone: "success",
      children: [
        { type: "markdown", markdown: "Inserted through the JSON API." },
      ],
    });

    assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
    await canvas
      .getByText("Inserted through the JSON API.", { exact: true })
      .waitFor();
    assert.doesNotMatch(await canvas.innerText(), /Layout failed:/);
    console.log("E2E checkpoint", report.checks.length);
    report.checks.push(
      "JSON API rejects lens, actor and path pitfalls without changing the document",
      "JSON API edits render live in the open canvas",
    );

    benchmarkCases.push({
      name,
      input: {
        reviewPath: path.join(legacyDir, "review.mdx"),
        evidence: {
          head: {
            sourceRootPath: path.join(
              worktreePath,
              ".git/dev-fast/reviews",
              metadata.sourceUuid,
              "head",
              metadata.sourceCommit,
            ),
          },
          base: {
            sourceRootPath: path.join(
              worktreePath,
              ".git/dev-fast/reviews",
              metadata.sourceUuid,
              "base",
              metadata.baseCommit,
            ),
          },
        },
      },
      cli: { uuid: metadata.sourceUuid, cwd: worktreePath },
    });
    report.checks.push(
      `${name}: imported ${snapshot.version + 1} version(s) matching the block golden and rendered in the JSON canvas`,
    );
    console.log("E2E legacy fixture passed", name);
  }

  assert.deepEqual(pageErrors, []);
  await page.locator(".review-canvas-root").click({ trial: true });
  await page.screenshot({ path: path.join(root, "document.png") });
  console.log("E2E checkpoint", report.checks.length);
  report.checks.push("no renderer page errors during authoring and import");
  report.functionalSuccess = true;

  if (values["baseline-runtime"]) {
    // Compare the same original corpus supported by both implementations.
    await writeFile(path.join(dir, "review.mdx"), source);
    const tutorialDir = path.join(root, "benchmark-tutorial");
    await cp(path.join(sourcePackage, "tutorial"), tutorialDir, {
      recursive: true,
    });
    await cp(recordPath, path.join(tutorialDir, "review.json"));
    benchmarkCases.push({
      name: "tutorial",
      input: { reviewPath: path.join(tutorialDir, "review.mdx") },
    });

    for (const fixture of benchmarkCases.filter((fixture) => !fixture.cli)) {
      const sourceRepo = path.join(root, `benchmark-${fixture.name}-repo`);
      await exec("git", [
        "clone",
        "--no-hardlinks",
        "--quiet",
        path.join(sourcePackage, "tutorial/git-stub"),
        sourceRepo,
      ]);

      const tutorialHead = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: sourceRepo })
      ).stdout.trim();

      const tutorialBase = (
        await exec("git", ["rev-parse", "HEAD~1"], { cwd: sourceRepo })
      ).stdout.trim();

      const binding = (
        await cli(
          ["scaffold", "--base", tutorialBase, "--head", tutorialHead],
          0,
          sourceRepo,
        )
      ).find((event) => event.reviews?.length).reviews[0];

      for (const file of [
        "review.mdx",
        "data.ts",
        "authoring-conversation.json",
      ])
        await cp(
          path.join(path.dirname(fixture.input.reviewPath), file),
          path.join(binding.dir, file),
        );
      fixture.cli = { uuid: binding.uuid, cwd: sourceRepo };
      fixture.input.evidence = {
        head: { sourceRootPath: sourceRepo },
        base: {
          sourceRootPath: path.join(
            sourceRepo,
            ".git/dev-fast/reviews",
            binding.uuid,
            "base",
            tutorialBase,
          ),
        },
      };
      await cli(["publish", "--review", binding.uuid], 0, sourceRepo);
    }

    const { benchmark } = await import("./benchmark-native-authoring.mjs");

    const result = await benchmark({
      runtime,
      baselineRuntime: await realpath(values["baseline-runtime"]),
      cases: [...benchmarkCases].sort(
        (left, right) =>
          Number(right.name === "schema4-three-minute-tour") -
          Number(left.name === "schema4-three-minute-tour"),
      ),
      env,
      output: path.join(root, "benchmark.json"),
      resumeFrom: values["resume-benchmark"],
    });

    report.benchmarkPass = result.pass;

    if (values["comparison-runtime"]) {
      const comparison = await benchmark({
        runtime,
        baselineRuntime: await realpath(values["comparison-runtime"]),
        cases: benchmarkCases,
        env,
        output: path.join(root, "benchmark-prior.json"),
      });

      report.comparisonPass = comparison.pass;
    }
  }

  assert.deepEqual(pageErrors, []);
  success = true;
} finally {
  if (!success && page) {
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
    JSON.stringify({ ...report, success, pageErrors }, null, 2),
  );
  await browser?.close();

  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    /* Already exited. */
  }

  await sleep(500);

  try {
    process.kill(-app.pid, "SIGKILL");
  } catch {
    /* Normal shutdown. */
  }

  console.log(JSON.stringify({ ...report, success }));

  if (success && !values.keep) await rm(root, { recursive: true, force: true });
}
