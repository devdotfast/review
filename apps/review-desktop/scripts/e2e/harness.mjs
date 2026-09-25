/** Shared launch/attach/report harness for scripts/e2e/journeys/*. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
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

/** The one record a home's single Desktop wrote; undefined before it starts. */
export async function instanceRecordPath(home) {
  const dir = path.join(home, "review-desktop/instances");
  const [name] = await readdir(dir).catch(() => []);

  return name && path.join(dir, name);
}

/** The community invitation a fresh profile shows (reviewCommunity.contribution.ts). */
export const COMMUNITY_INVITATION = "Join the Whiteboard community";

/** Playwright's name for the platform's primary modifier: Cmd on macOS, Ctrl on Linux and Windows. */
export const PRIMARY_MODIFIER = "ControlOrMeta";

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
  // Development mode launches `scripts/run.sh`, which needs a POSIX shell and a code-oss checkout.
  if (!packagedApp && process.platform === "win32")
    throw new Error(
      "development mode needs macOS or Linux; pass --app with an installed Whiteboard",
    );

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
    DEV_FAST_REVIEW_TELEMETRY_ENV: "e2e",
    DEV_REVIEW_EXTENSIONS: extensions,
  };

  // `whiteboard migrate apply` looks for (and may uninstall) global CLIs through each package manager's global root, so those point into the temp root.
  const globals = path.join(root, "package-manager-globals");

  Object.assign(env, {
    npm_config_prefix: path.join(globals, "npm"),
    PNPM_HOME: path.join(globals, "pnpm"),
    YARN_GLOBAL_FOLDER: path.join(globals, "yarn"),
    BUN_INSTALL: path.join(globals, "bun"),
  });

  // Node and most Windows tools find the profile through USERPROFILE and APPDATA, not HOME, so those move into the temp home too.
  if (process.platform === "win32")
    Object.assign(env, {
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    });

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

    // Once the profile holds two sessions a window can show the community invitation; any answer is final.
    await candidate.addLocatorHandler(
      candidate.getByText(COMMUNITY_INVITATION, { exact: true }),
      async () => {
        await candidate
          .getByRole("button", { name: "Not now", exact: true })
          .click();
      },
    );
  }

  await mkdir(path.join(userData, "User"), { recursive: true });

  if (process.platform === "win32")
    for (const key of ["APPDATA", "LOCALAPPDATA"])
      await mkdir(env[key], { recursive: true });

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
          `--extensions-dir=${path.join(profile, "extensions")}`,
          `--remote-debugging-port=${port}`,
        ]
      : [path.join(appRoot, "scripts/run.sh")];

    // Detached on POSIX so the whole process group can be signalled; Windows stops the tree with taskkill instead.
    app = spawn(
      packagedApp ? packagedExecutable(packagedApp) : "bash",
      launchArgs,
      {
        cwd: appRoot,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
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
        await readFile(await instanceRecordPath(home), "utf8"),
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

    const dialog = candidate.getByText(COMMUNITY_INVITATION, { exact: true });

    // It needs two sessions and is asked once per profile, so absence is the usual case.
    const shown = await dialog
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    if (!shown) return;

    await candidate
      .getByRole("button", { name: "Not now", exact: true })
      .click()
      .catch(() => {});
    await dialog.waitFor({ state: "hidden", timeout: 30000 });
  }

  /** Stops the Desktop and everything it started: its POSIX process group, or its Windows process tree. */
  async function killGroup(signal) {
    if (process.platform === "win32") {
      // Without /F taskkill asks the windows to close, the nearest Windows has to SIGTERM; /T takes the children too.
      await exec("taskkill", [
        "/pid",
        String(app.pid),
        "/T",
        ...(signal === "SIGKILL" ? ["/F"] : []),
      ]).catch(() => {
        /* Already exited, or the tree is already gone. */
      });

      return;
    }

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
    await killGroup("SIGTERM");
    await sleep(500);
    await killGroup("SIGKILL");
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

    // A signal death leaves exitCode null and sets signalCode instead.
    const running = () => app.exitCode === null && app.signalCode === null;

    while (running() && Date.now() < deadline) await sleep(100);

    if (running()) throw new Error(`Timed out waiting for ${label}`);
  }

  /** `signal: "SIGKILL"` stops the Desktop without letting it run any shutdown handler. */
  async function restartDesktop({ signal = "SIGTERM", beforeRelaunch } = {}) {
    lifecycle(`Restarting with ${signal}`);
    await killGroup(signal);

    try {
      await waitForExit("Desktop shutdown");
    } catch {
      // A respawn while the old instance still holds the CDP port and its instance record would attach to the dying Desktop.
      await killGroup("SIGKILL");
      await waitForExit("Desktop shutdown after SIGKILL");
    }

    // Anything that must happen while no Desktop holds the files, such as moving a repository on Windows.
    await beforeRelaunch?.();
    await relaunch();
  }

  /**
   * Quits the way a reader does, then relaunches: `workbench.action.quit` (Cmd/Ctrl+Q) on macOS and Linux; Windows binds
   * no quit key, so there closing the last window (`workbench.action.closeWindow`, Ctrl+Shift+W) is what quits.
   */
  async function quitAndRelaunchDesktop() {
    const win = process.platform === "win32";

    lifecycle(
      `Quitting through ${win ? "workbench.action.closeWindow" : "workbench.action.quit"}`,
    );
    await page.keyboard.press(
      win ? "Control+Shift+KeyW" : "ControlOrMeta+KeyQ",
    );
    await waitForExit("Desktop quit");
    await relaunch();
  }

  async function relaunch() {
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
      await killGroup("SIGTERM");

      await sleep(500);

      await killGroup("SIGKILL");
    }

    console.log(JSON.stringify({ ...report, success }));

    // Windows can hold a just-killed Desktop's files for a moment, so the removal retries.
    if (success && !keep)
      await rm(root, { recursive: true, force: true, maxRetries: 10 });

    return success;
  }

  return Object.assign(ctx, {
    api,
    appLog: () => appLog,
    /** The pid of the Desktop this harness launched; its descendants are this journey's own processes. */
    desktopPid: () => app.pid,
    apiOk,
    apiCanvasFor,
    cli,
    cliRaw,
    check: (...names) => report.checks.push(...names),
    knownBug,
    restartDesktop,
    quitAndRelaunchDesktop,
    close,
  });
}

/** Creates a review on spec's commits, inserts its blocks and opens it; returns { reviewId, repositoryId, title, canvas }. */
export async function createReview(ctx, spec) {
  const repository = await ctx.api("/reviews-api/repositories", "POST", {
    path: spec.repoPath ?? ctx.repo,
  });

  assert.equal(repository.status, 200, JSON.stringify(repository.value));

  const command = async (operation) => {
    const result = await ctx.api("/reviews-api/commands", "POST", {
      commandId: randomUUID(),
      operation,
    });

    assert.equal(result.status, 200, JSON.stringify(result.value));

    return result.value;
  };

  const { reviewId } = await command({
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
      reviewId,
      edit: { type: "insert", content },
    });

  const opened = await ctx.api(`/reviews-api/${reviewId}/open`, "POST", {});

  assert.equal(opened.status, 200, JSON.stringify(opened.value));

  const page = await ctx.apiCanvasFor(spec.title);

  return {
    reviewId,
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
    source: {
      file: "order.ts",
      start: { side: "head", line: 1 },
      end: { side: "head", line: 1 },
    },
  },
];

/**
 * Waits for the native Source window (`<review> — Source — Whiteboard`) that Go to Definition and Open file now open,
 * with `fileName` as its active editor, and returns that window's page.
 */
export async function sourceWindowFor(ctx, fileName, label = fileName) {
  const source = await ctx.until(async () => {
    for (const candidate of ctx.browser
      .contexts()
      .flatMap((context) => context.pages())) {
      if (!(await candidate.title().catch(() => "")).includes(" — Source — "))
        continue;

      const active = await candidate
        .locator(".tabs-container .tab.active")
        .first()
        .getAttribute("aria-label", { timeout: 1000 })
        .catch(() => null);

      if (active?.includes(fileName)) return candidate;
    }

    return null;
  }, `the Source window to open ${label}`);

  await ctx.watchPage(source);

  return source;
}

/** Closes a Source window the way a reader does, with Close Window (Cmd/Ctrl+Shift+W). */
export async function closeSourceWindow(source) {
  const closed = source.waitForEvent("close", { timeout: 30000 });

  await source.keyboard.press(`${PRIMARY_MODIFIER}+Shift+KeyW`);
  await closed;
}

/** Opens a review the way a reader does, with `whiteboard app pick --session`. */
export async function pickReview(ctx, reviewId, cwd = ctx.repo) {
  const picked = await ctx.cliRaw(
    ["app", "pick", "--session", reviewId, "--json"],
    cwd,
  );

  // The CLI writes its error event to stdout, not stderr.
  assert.equal(picked.code, 0, `app pick: ${picked.stdout}\n${picked.stderr}`);
}

/** Opens the Settings page on the current `ctx.page`; Cmd/Ctrl+, repeats because a fresh profile reloads the workbench. */
export async function openSettings(ctx) {
  const settings = ctx.page.locator(
    ".review-home-content.review-settings-page",
  );

  await ctx.until(
    async () => {
      await ctx.page.keyboard.press(`${PRIMARY_MODIFIER}+Comma`);

      return await settings.waitFor({ state: "visible", timeout: 5000 }).then(
        () => true,
        () => false,
      );
    },
    "the Settings page after Cmd/Ctrl+,",
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

/** `--app` names a macOS bundle, or the installed executable on Linux and Windows. */
function packagedExecutable(app) {
  if (!app.endsWith(".app")) return app;

  // The bundle's one executable is named after the product (`Whiteboard` today), so it is found rather than spelled.
  const macos = path.join(app, "Contents", "MacOS");

  const [executable, ...others] = readdirSync(macos);

  assert.ok(
    executable && others.length === 0,
    `${macos} should hold exactly one executable, found ${[executable, ...others].join(", ")}`,
  );

  return path.join(macos, executable);
}
