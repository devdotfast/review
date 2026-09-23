/** Shared launch/attach/report harness for scripts/e2e/journeys/*. */
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
import { promisify } from "node:util";

import { assertRuntimeContents } from "../stage-review-runtime.mjs";

const exec = promisify(execFile);

export const appRoot = path.resolve(import.meta.dirname, "../..");

export const workspace = path.resolve(appRoot, "../..");

export const sourcePackage = path.join(workspace, "packages/review");

export const bugsLogPath = path.join(import.meta.dirname, "KNOWN_BUGS.md");

const require = createRequire(path.join(appRoot, "code-oss/package.json"));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pages `watchPage` has instrumented; attaching twice doubles every page error and races two dialog handlers. */
const watchedPages = new WeakSet();

const defaultSettings = {
  "review.experimental.softwareMap.enabled": true,
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "workbench.startupEditor": "none",
};

export async function createHarness({
  runtime,
  app: packagedApp,
  keep = false,
  journey,
  extensions = "none",
  settings = {},
  seedRepo = true,
  env: extraEnv = {},
  beforeLaunch,
  disableCommunityHandler = false,
}) {
  // Required lazily so `run.mjs --list` works without code-oss/node_modules.
  const { chromium } = require("playwright-core");

  await assertRuntimeContents(runtime);

  const root = await realpath(
    await mkdtemp(
      path.join(
        process.platform === "darwin" ? "/tmp" : os.tmpdir(),
        `review-e2e-${journey}-`,
      ),
    ),
  );

  const home = path.join(root, "home");

  const repo = path.join(root, "repo");

  await mkdir(repo);

  const env = {
    ...process.env,
    HOME: home,
    DEV_REVIEW_HOME: home,
    DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
    DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
    DEV_REVIEW_EXTENSIONS: extensions,
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

  // An empty override means "unset this variable for the journey".
  for (const [key, value] of Object.entries(extraEnv))
    if (value === "") delete env[key];
    else env[key] = value;

  const git = async (...args) =>
    (await exec("git", args, { cwd: repo, env })).stdout.trim();

  let base = "";

  let head = "";

  if (seedRepo) {
    // A stand-in repository: a legacy record only loads when its worktreePath exists.
    await git("init", "-q", "-b", "main");

    await git("config", "user.name", "Review E2E");

    await git("config", "user.email", "review-e2e@example.invalid");

    await writeFile(
      path.join(repo, "order.ts"),
      'export const status = "draft";\n',
    );

    await git("add", ".");

    await git("commit", "-qm", "Draft");

    base = await git("rev-parse", "HEAD");

    await writeFile(
      path.join(repo, "order.ts"),
      'export const status = "queued";\n',
    );

    await git("commit", "-qam", "Queue");

    head = await git("rev-parse", "HEAD");
  }

  const profile = path.join(home, "review-desktop/state");

  const userData = path.join(profile, "user-data");

  const pageErrors = [];

  const requestUrls = [];

  const report = {
    mode: packagedApp ? "packaged" : "development",
    runtime,
    journey,
    root,
    checks: [],
    knownBugs: [],
  };

  let appLog = "";

  let app;

  let browser;

  let page;

  let discovery;

  function lifecycle(message) {
    appLog += `\n[E2E ${new Date().toISOString()}] ${message}\n`;
  }

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

  async function watchPage(candidate) {
    if (watchedPages.has(candidate)) return;
    watchedPages.add(candidate);

    candidate.on("pageerror", (error) => pageErrors.push(error.message));
    candidate.on("request", (request) => requestUrls.push(request.url()));
    candidate.on("close", () => lifecycle("Workbench page closed"));

    if (disableCommunityHandler) return;

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

  await mkdir(path.join(userData, "User"), { recursive: true });

  await writeFile(
    path.join(userData, "User/settings.json"),
    JSON.stringify({ ...defaultSettings, ...settings }),
  );

  const ctx = {
    root,
    home,
    repo,
    runtime,
    profile,
    userData,
    env,
    git,
    base,
    head,
    pageErrors,
    requestUrls,
    report,
    until,
    watchPage,
  };

  await beforeLaunch?.(ctx);

  const portServer = createServer();

  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));

  const port = portServer.address().port;

  await new Promise((resolve) => portServer.close(resolve));

  env.DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT = String(port);

  function spawnDesktop() {
    const launchArgs = packagedApp
      ? [
          "--disable-telemetry",
          "--skip-welcome",
          `--user-data-dir=${userData}`,
          `--extensions-dir=${profile}/extensions`,
          `--remote-debugging-port=${port}`,
        ]
      : [path.join(appRoot, "scripts/run.sh")];

    app = spawn(
      packagedApp ? path.join(packagedApp, "Contents/MacOS/Review") : "bash",
      launchArgs,
      { cwd: appRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    app.on("exit", (code, signal) =>
      lifecycle(`Desktop exit: ${code}, ${signal}`),
    );

    app.stdout.on("data", (chunk) => {
      appLog = (appLog + chunk).slice(-200000);
    });

    app.stderr.on("data", (chunk) => {
      appLog = (appLog + chunk).slice(-200000);
    });
  }

  async function attach() {
    discovery = await until(async () => {
      const value = JSON.parse(
        await readFile(path.join(home, "review-desktop/server.json"), "utf8"),
      );

      const health = await (await fetch(`${value.url}/health`)).json();

      return health.ok && health.desktopAttached ? value : null;
    }, "attached Desktop server");
    ctx.discovery = discovery;

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    browser.on("disconnected", () => lifecycle("Desktop CDP disconnected"));
    ctx.browser = browser;
    page = await until(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url().includes("workbench")),
      "workbench renderer",
    );
    ctx.page = page;
    await watchPage(page);
    await dismissCommunityDialog(page);
  }

  // The locator handler runs only during locator actions, so a keyboard-first journey would type into the modal.
  async function dismissCommunityDialog(candidate) {
    if (disableCommunityHandler) return;

    const dialog = candidate.getByText("Join the Review community", {
      exact: true,
    });

    // A restarted profile has already stored the "don't show again" choice, so absence is normal.
    const shown = await dialog
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    if (!shown) return;

    await candidate
      .getByRole("checkbox", { name: "Don't show again" })
      .check()
      .catch(() => {});
    await candidate
      .getByRole("button", { name: "Not now", exact: true })
      .click()
      .catch(() => {});
    await dialog.waitFor({ state: "hidden", timeout: 30000 });
  }

  function killGroup(signal) {
    try {
      process.kill(-app.pid, signal);
    } catch {
      /* Already exited. */
    }
  }

  /** A close that can neither throw nor hang; the kill below is what actually stops the Desktop. */
  const closeBrowser = () =>
    Promise.race([browser?.close().catch(() => {}) ?? null, sleep(10000)]);

  spawnDesktop();

  try {
    await attach();
  } catch (error) {
    // The only chance to stop the detached Desktop and keep the log that says why it never attached.
    await closeBrowser();
    killGroup("SIGTERM");
    await sleep(500);
    killGroup("SIGKILL");
    await writeFile(path.join(root, "app.log"), appLog).catch(() => {});

    throw error;
  }

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

  /** `api` plus a 200 assertion: an error body is JSON too, so an unasserted read can stand in for a document. */
  const apiOk = async (route, method = "GET", body) => {
    const result = await api(route, method, body);

    assert.equal(
      result.status,
      200,
      `${method} ${route} answered ${result.status}: ${JSON.stringify(result.value)}`,
    );

    return result.value;
  };

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

  // `timeout` shortens the wait for a command known to hang; an empty `env` override unsets a key.
  async function cliRaw(args, cwd = repo, { timeout = 60000, env: over } = {}) {
    const commandEnv = { ...env, ...over };

    for (const [key, value] of Object.entries(over ?? {}))
      if (value === "") delete commandEnv[key];

    try {
      return {
        ...(await exec(
          process.execPath,
          [path.join(runtime, "dist/cli.js"), ...args],
          {
            cwd,
            env: commandEnv,
            timeout,
            maxBuffer: 8 * 1024 * 1024,
          },
        )),
        code: 0,
      };
    } catch (error) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: error.code,
        // True when `timeout` stopped it: the command never exited on its own.
        killed: Boolean(error.killed),
        signal: error.signal ?? null,
      };
    }
  }

  async function cli(args, cwd = repo) {
    // The initial workbench reload can detach the relay, so retry only the read-only info readiness failure.
    const result = await until(async () => {
      const health = await (await fetch(`${discovery.url}/health`)).json();

      if (!health.ok || !health.desktopAttached) return null;

      try {
        return {
          ...(await exec(
            process.execPath,
            [path.join(runtime, "dist/cli.js"), ...args, "--json"],
            { cwd, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
          )),
          code: 0,
        };
      } catch (error) {
        if (
          args[0] === "info" &&
          error.stdout?.includes("Review Desktop is not ready.")
        )
          return null;

        return {
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
          code: error.code,
        };
      }
    }, "fixture Desktop CLI readiness");

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

  async function knownBug(heading) {
    const log = await readFile(bugsLogPath, "utf8");
    const escaped = heading.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

    assert.match(
      log,
      new RegExp(`^## ${escaped}$`, "m"),
      `"${heading}" is not a heading in ${bugsLogPath}`,
    );

    if (!report.knownBugs.includes(heading)) report.knownBugs.push(heading);
  }

  // `until` throws as soon as the Desktop exits, which is the opposite of waiting for a shutdown.
  async function waitForExit(label, timeout = 30000) {
    const deadline = Date.now() + timeout;

    while (app.exitCode === null && Date.now() < deadline) await sleep(100);

    if (app.exitCode === null)
      throw new Error(`Timed out waiting for ${label}`);
  }

  async function restartDesktop() {
    killGroup("SIGTERM");

    try {
      await waitForExit("Desktop shutdown");
    } catch {
      // A respawn while the old instance still holds the CDP port and server.json would attach to the dying Desktop.
      killGroup("SIGKILL");
      await waitForExit("Desktop shutdown after SIGKILL");
    }

    await browser?.close();
    spawnDesktop();
    await attach();
  }

  /** Returns the effective success; a renderer page error flips it to false. */
  async function close({ success }) {
    try {
      if (success)
        try {
          assert.deepEqual(pageErrors, []);
        } catch (error) {
          report.error = error.message;
          success = false;
        }

      // Artifacts are best-effort: a Desktop that outlives the runner is worse than a missing screenshot.
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
        ).catch(() => {});
      }

      await writeFile(path.join(root, "app.log"), appLog).catch(() => {});
      await writeFile(
        path.join(root, "report.json"),
        JSON.stringify({ ...report, success, pageErrors }, null, 2),
      ).catch(() => {});
      await closeBrowser();
    } finally {
      killGroup("SIGTERM");

      await sleep(500);

      killGroup("SIGKILL");
    }

    console.log(JSON.stringify({ ...report, success }));

    if (success && !keep) await rm(root, { recursive: true, force: true });

    return success;
  }

  return Object.assign(ctx, {
    api,
    apiOk,
    apiCanvasFor,
    cli,
    cliRaw,
    check: (...names) => report.checks.push(...names),
    knownBug,
    restartDesktop,
    close,
  });
}

/** Creates a review on spec's commits, inserts its blocks and opens it; returns { sessionId, repositoryId, title, canvas }. */
export async function createReview(ctx, spec) {
  const repository = await ctx.api("/sessions-api/repositories", "POST", {
    path: spec.repoPath ?? ctx.repo,
  });

  assert.equal(repository.status, 200, JSON.stringify(repository.value));

  const command = async (operation) => {
    const result = await ctx.api("/sessions-api/commands", "POST", {
      commandId: randomUUID(),
      operation,
    });

    assert.equal(result.status, 200, JSON.stringify(result.value));

    return result.value;
  };

  const { sessionId } = await command({
    type: "create",
    title: spec.title,
    target: {
      kind: "commits",
      repositoryId: repository.value.id,
      head: spec.head ?? ctx.head,
      base: spec.base ?? ctx.base,
    },
  });

  for (const content of spec.blocks)
    await command({
      type: "edit",
      sessionId,
      edit: { type: "insert", content },
    });

  const opened = await ctx.api(`/sessions-api/${sessionId}/open`, "POST", {});

  assert.equal(opened.status, 200, JSON.stringify(opened.value));

  const page = await ctx.apiCanvasFor(spec.title);

  return {
    sessionId,
    repositoryId: repository.value.id,
    title: spec.title,
    canvas: page.locator(".review-canvas-root [data-review-api]"),
  };
}

/** The standard two-block order review used by several journeys. */
export const orderReviewBlocks = [
  {
    type: "section",
    title: "Overview",
    children: [
      {
        type: "markdown",
        markdown: "The order **status** moves from draft to queued.",
      },
    ],
  },
  {
    type: "code_peek",
    source: { side: "head", file: "order.ts", fromLine: 1, toLine: 1 },
  },
];

/** Closes with one Escape the modal editor Go to Definition opens; `focus` is what must hold focus when the key lands. */
export async function dismissModalEditor(
  ctx,
  page = ctx.page,
  focus = ".monaco-modal-editor-block",
) {
  const modalEditor = page.locator(".monaco-modal-editor-block").first();

  const opened = await modalEditor.waitFor({ timeout: 10000 }).then(
    () => true,
    () => false,
  );

  if (!opened) return false;

  // Which element holds focus decides which Escape rule runs, so the press is measured only once it has settled.
  await ctx.until(
    () =>
      page.evaluate(
        (selector) => document.activeElement?.closest(selector) != null,
        focus,
      ),
    `${focus} to take focus in the modal editor`,
    10000,
  );
  await page.keyboard.press("Escape");
  await modalEditor.waitFor({ state: "detached", timeout: 5000 });

  return true;
}

/** Opens a review the way a reader does, with `review app pick --review`. */
export async function pickReview(ctx, sessionId, cwd = ctx.repo) {
  const picked = await ctx.cliRaw(
    ["app", "pick", "--review", sessionId, "--json"],
    cwd,
  );

  // The CLI writes its error event to stdout, not stderr.
  assert.equal(picked.code, 0, `app pick: ${picked.stdout}\n${picked.stderr}`);
}

/** Opens the Settings page on the current `ctx.page`; `Meta+,` repeats because a fresh profile reloads the workbench. */
export async function openSettings(ctx) {
  const settings = ctx.page.locator(
    ".review-home-content.review-settings-page",
  );

  await ctx.until(
    async () => {
      await ctx.page.keyboard.press("Meta+,");

      return await settings.waitFor({ state: "visible", timeout: 5000 }).then(
        () => true,
        () => false,
      );
    },
    "the Settings page after Meta+,",
    60000,
  );

  return settings;
}

/** Installs an optional extension group through Settings → Tools → Extensions → "Manage…", the only consent path to Open VSX. */
export async function installExtensionGroup(
  ctx,
  { label, extensionId, timeout = 600000 },
) {
  const settings = await openSettings(ctx);

  await settings
    .locator(".review-settings-row")
    .filter({ hasText: "Extensions" })
    .getByRole("button", { name: "Manage" })
    .click();

  const picker = ctx.page.locator(".quick-input-widget");

  const row = picker
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: label })
    .first();

  await row.waitFor({ timeout: 60000 });

  // The picker's checkbox is a `div[role=checkbox]` widget, not an `<input>`.
  await row.getByRole("checkbox").check();

  // The button reads "Install N extensions" only while the group has uninstalled members, so the label proves a download.
  await picker
    .getByRole("button", { name: /^Install \d+ extensions?$/ })
    .first()
    .click();

  // The unpacked directory is the completion signal: the picker's notification is transient and the window reloads.
  const extensionsDir = path.join(ctx.profile, "extensions");

  await ctx.until(
    async () =>
      (await readdir(extensionsDir).catch(() => [])).some((entry) =>
        entry.toLowerCase().startsWith(`${extensionId.toLowerCase()}-`),
      ),
    `${extensionId} to be installed from Open VSX`,
    timeout,
  );

  // The install ends in a window reload, which has to be up again before a journey touches the workbench.
  await ctx.page.locator(".monaco-workbench").waitFor({ timeout: 120000 });
}

/** Brings the Home canvas to the front by activating its editor tab; falls back to a restart. */
export async function openHome(ctx) {
  const tab = ctx.page
    .locator(".tabs-container .tab")
    .filter({ hasText: /^Home$/ })
    .first();

  if (await tab.count()) await tab.click();
  else await ctx.restartDesktop();
  await ctx.page.locator("main.review-home").waitFor({ timeout: 60000 });
}
