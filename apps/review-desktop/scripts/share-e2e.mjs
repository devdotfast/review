/** Visible Desktop proof of an imported JSON review with an independently fetched pinned checkout. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);

const appRoot = path.resolve(import.meta.dirname, ".."),
  workspace = path.resolve(appRoot, "../..");

const require = createRequire(path.join(appRoot, "code-oss/package.json"));

const { chromium } = require("playwright-core");

const { values } = parseArgs({
  options: {
    "local-only": { type: "boolean" },
    github: { type: "boolean" },
    lsp: { type: "boolean" },
    root: { type: "string" },
    keep: { type: "boolean" },
  },
});

const root = values.root ?? (await mkdtemp("/tmp/review-share-e2e-"));

await mkdir(root, { recursive: true });

let fixture;

try {
  fixture = JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));
} catch {
  await exec(
    "pnpm",
    [
      "exec",
      "tsx",
      "packages/review/scripts/seed-share-fixture.ts",
      root,
      ...(values.github ? ["--github"] : []),
      ...(values.lsp ? ["--lsp"] : []),
    ],
    { cwd: workspace },
  );
  fixture = JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));
}

const profile = path.join(fixture.home, "review-desktop/state/user-data/User");

await mkdir(profile, { recursive: true });

await writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    "review.experimental.softwareMap.enabled": true,
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
  }),
);

if (values.lsp) {
  const extension = path.join(
    fixture.home,
    "review-desktop/state/extensions/review-test.review-lsp-e2e-1.0.0",
  );

  await mkdir(extension, { recursive: true });
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
}

const server = createServer();

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const port = server.address().port;

await new Promise((resolve) => server.close(resolve));

const env = {
  ...process.env,
  DEV_WHITEBOARD_HOME: fixture.home,
  REVIEW_LSP_E2E_ROOT: root,
  DEV_WHITEBOARD_EXTENSIONS: "none",
  DEV_FAST_WHITEBOARD_SHARED_DATA_DIR: path.join(root, "shared-data"),
  DEV_FAST_WHITEBOARD_REMOTE_DEBUGGING_PORT: String(port),
  DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED: "1",
  DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE: "1",
};

const app = spawn("bash", [path.join(appRoot, "scripts/run.sh")], {
  cwd: appRoot,
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";

for (const stream of [app.stdout, app.stderr])
  stream.on("data", (chunk) => {
    log = (log + chunk).slice(-100000);
  });

const until = async (fn, label) => {
  const deadline = Date.now() + 120000;
  let error;

  while (Date.now() < deadline) {
    try {
      const result = await fn();

      if (result) return result;
    } catch (cause) {
      error = cause;
    }

    if (app.exitCode !== null)
      throw new Error(`Desktop exited: ${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out: ${label}: ${error?.message ?? ""}`);
};

let browser, page;

try {
  const discovery = await until(async () => {
    const value = JSON.parse(
      await readFile(
        path.join(fixture.home, "review-desktop/server.json"),
        "utf8",
      ),
    );

    const health = await (await fetch(value.url + "/health")).json();

    return health.ok && health.desktopAttached ? value : null;
  }, "Desktop attached");

  assert.equal(discovery.appPid, app.pid, "isolated implementation process");

  const api = async (route, body) => {
    const response = await fetch(discovery.url + "/sessions-api" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-whiteboard-token": discovery.token,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const value = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);

    return value;
  };

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((value) => value.url().includes("workbench")),
    "workbench",
  );
  await page.addLocatorHandler(
    page.getByText("Join the Review community", { exact: true }),
    async () => {
      const button = page.getByRole("button", { name: "Not now", exact: true });

      if (await button.count()) await button.click();
    },
  );
  await page
    .getByText("Sharing pinned commits", { exact: true })
    .waitFor({ timeout: 60000 });
  await api(`/${fixture.sessionId}/open`, {});
  await page
    .getByText("A portable review", { exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByText("Shared by fixture-sender", { exact: true }).waitFor();
  await page.getByText("The answer is 42.", { exact: true }).first().waitFor();
  const image = page.getByAltText("Embedded red pixel");
  await image.scrollIntoViewIfNeeded();
  assert.ok(
    await image.evaluate(
      (element) => element.complete && element.naturalWidth > 0,
    ),
  );

  // Native inline widgets expose their rendered code through Monaco's view lines.
  const code = page
    .locator(".view-lines")
    .filter({ hasText: fixture.sourceText })
    .first();

  await code.scrollIntoViewIfNeeded();
  await code.waitFor();
  await page.screenshot({ path: path.join(root, "shared-desktop.png") });
  await page.getByRole("button", { name: "Trace", exact: true }).click();
  await page.getByText("Please compute the answer.", { exact: true }).waitFor();
  await page
    .getByText("The answer is 42. This entire conversation is retained.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: path.join(root, "shared-trace.png") });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Open File", exact: true })
    .first()
    .click();
  await page
    .locator(".view-lines")
    .filter({ hasText: fixture.sourceText })
    .first()
    .waitFor();
  await page.screenshot({ path: path.join(root, "shared-source.png") });

  if (values.lsp) {
    const probe = async (request) => {
      const id = randomUUID();
      await writeFile(
        path.join(root, "request.json"),
        JSON.stringify({ ...request, id }),
      );
      await page.keyboard.press("F1");
      await page
        .locator(".quick-input-widget input")
        .fill(">Review E2E: Language probe");
      await page
        .getByRole("option", { name: /Review E2E: Language probe/ })
        .first()
        .click();

      const result = await until(
        async () =>
          JSON.parse(await readFile(path.join(root, `${id}.json`), "utf8")),
        "language probe",
      );

      assert.equal(result.error, undefined);

      return result;
    };

    const location = {
      uri: `review-api-source://${fixture.sessionId}/answer.ts?version=${fixture.version}&side=head`,
      line: 0,
      character: 18,
    };

    await until(async () => {
      const response = await probe({
        ...location,
        open: true,
        feature: "vscode.executeHoverProvider",
      });

      return JSON.stringify(response.result).includes("answer(): number");
    }, "shared TypeScript hover");
    await probe({
      ...location,
      open: true,
      command: "editor.action.showHover",
    });
    await page
      .locator(".monaco-hover:visible")
      .filter({ hasText: "answer" })
      .first()
      .waitFor();
    await page.screenshot({ path: path.join(root, "shared-hover.png") });
  }

  const source = await api(
    `/${fixture.sessionId}/file?side=head&file=${encodeURIComponent(fixture.sourceFile)}`,
  );

  assert.ok(source.text.includes(fixture.sourceText));
  const summary = await api(`/${fixture.sessionId}?full=true`);
  assert.equal(summary.version, fixture.version);
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(
      {
        root,
        sessionId: fixture.sessionId,
        checks: [
          "actual Desktop canvas",
          "native pinned source",
          "embedded image",
          "full trace conversation",
          "native Open file",
          "sender attribution",
          "sender repository unavailable; recipient checkout retained",
          ...(fixture.github
            ? ["published GitHub commits fetched into clean recipient checkout"]
            : []),
          ...(values.lsp
            ? ["real TypeScript hover on the pinned shared source"]
            : []),
        ],
        screenshot: path.join(root, "shared-desktop.png"),
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Desktop sharing proof: ${root}\n`);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(root, "failure.png") })
      .catch(() => {});
  await writeFile(path.join(root, "app.log"), log);
  throw error;
} finally {
  await browser?.close();

  if (!values.keep)
    try {
      process.kill(-app.pid, "SIGTERM");
    } catch {}
}
