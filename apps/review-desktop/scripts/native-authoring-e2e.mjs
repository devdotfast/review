/** Legacy fixture -> import -> Desktop rendering gate, with isolated
 * stores/profiles. The schema-4 fixture tarballs are the only seed: the MDX
 * authoring verbs that used to scaffold and publish a review are gone.
 * Run after building Desktop and staging a production Review package:
 * node scripts/native-authoring-e2e.mjs --runtime /absolute/production-package
 * Add --app /absolute/Review.app to exercise the packaged application.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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

// A stand-in repository for the fixture whose own source repository is not on
// this machine: a legacy record only loads when its worktreePath exists.
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

await writeFile(
  path.join(repo, "order.ts"),
  'export const status = "queued";\n',
);

await git("commit", "-qam", "Queue");

const legacyRoot = path.join(sourcePackage, "src/fixtures/legacy-reviews");

const legacyFixtures = [];

// Seeded only after the Desktop attaches, so `app pick` exercises
// import-on-open rather than the Home sweep.
const DEFERRED_FIXTURE = "schema4-bug-report-dialog";

// The tarball plus its `<name>.json` metadata is the seed, the same shape
// `legacy-import-live-home.sh` extracts into a live-test home.
async function seedLegacyFixture(fixture) {
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

  if (!fixture.deferred) await seedLegacyFixture(fixture);
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

  async function cli(args, cwd) {
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
      0,
      `${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
    );

    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  }

  console.log("Desktop attached; exercising installed CLI", root);

  let jsonApiChecked = false;

  for (const fixture of legacyFixtures) {
    if (fixture.deferred) await seedLegacyFixture(fixture);

    const {
      name,
      metadata,
      legacyDir,
      worktreePath,
      legacyRecordPath,
      original,
    } = fixture;

    await cli(["info", "--review", metadata.sourceUuid], worktreePath);
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
      report.checks.push(
        `${name}: installed migration matches sealed JSON golden; unimportable review stays legacy`,
      );
      console.log("E2E legacy fixture passed", name);
      continue;
    }

    // E5: the Home sweep imported the eager fixtures during startup, so this
    // `app pick` only routes to the JSON canvas. E8: the deferred fixture is
    // imported by this open.
    if (!fixture.deferred) await waitForImport(metadata.sourceUuid);
    await cli(["app", "pick", "--review", metadata.sourceUuid], worktreePath);
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
    const canvas = page.locator(".review-canvas-root");

    if (metadata.hasMap) {
      // The imported map section starts collapsed.
      await canvas
        .getByRole("button", { name: "Expand Software map", exact: true })
        .click();
      await canvas.locator(".software-map").first().waitFor({ timeout: 30000 });
    }

    // E10: the JSON API rejects the pitfalls the render gate used to catch, and
    // accepts a valid block that then renders in the open canvas. One imported
    // fixture exercises it; the API is the same for all of them.
    if (!jsonApiChecked) {
      jsonApiChecked = true;

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

      assert.deepEqual(
        after,
        before,
        "rejected edits must not change the document",
      );

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
    }

    report.checks.push(
      `${name}: fixture review imports and renders in the JSON canvas, ${snapshot.version + 1} version(s) matching the block golden`,
    );
    console.log("E2E legacy fixture passed", name);
  }

  assert.deepEqual(pageErrors, []);
  await page.locator(".review-canvas-root").click({ trial: true });
  await page.screenshot({ path: path.join(root, "document.png") });
  console.log("E2E checkpoint", report.checks.length);
  report.checks.push("no renderer page errors during import and rendering");
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
