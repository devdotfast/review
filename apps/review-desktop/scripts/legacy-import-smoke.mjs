/** Real-review import smoke: launch the built Desktop on a COPIED review home
 * and verify every published legacy review imports into the JSON store, opens
 * in the JSON canvas, and renders without page errors.
 *
 *   SMOKE_HOME=$(mktemp -d /tmp/review-smoke-XXXX)
 *   mkdir -p "$SMOKE_HOME/reviews" && cp -R ~/.dev/reviews/. "$SMOKE_HOME/reviews/"
 *   node scripts/legacy-import-smoke.mjs --home "$SMOKE_HOME"
 *
 * Run from apps/review-desktop after `pnpm app:build`. The script refuses the
 * live ~/.dev home; copy only `reviews/` into a scratch home first.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const appRoot = path.resolve(import.meta.dirname, "..");

const require = createRequire(path.join(appRoot, "code-oss/package.json"));

const { chromium } = require("playwright-core");

const { values } = parseArgs({
  options: { home: { type: "string" }, out: { type: "string" } },
});

assert.ok(values.home, "--home must name a COPY of a review home");

const home = await realpath(values.home);

const liveHome = await realpath(path.join(os.homedir(), ".dev")).catch(
  () => null,
);

assert.notEqual(
  home,
  liveHome,
  "refusing to run against the live ~/.dev home; copy its reviews/ first",
);

const out = values.out ?? path.join(home, "shots");

await mkdir(out, { recursive: true });

const portServer = createServer();

await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));

const port = portServer.address().port;

await new Promise((resolve) => portServer.close(resolve));

const env = {
  ...process.env,
  DEV_REVIEW_HOME: home,
  DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1",
  DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
  DEV_REVIEW_EXTENSIONS: "none",
  DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT: String(port),
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

const profile = path.join(home, "review-desktop/state/user-data/User");

await mkdir(profile, { recursive: true });

await writeFile(
  path.join(profile, "settings.json"),
  JSON.stringify({
    "review.experimental.softwareMap.enabled": true,
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "workbench.startupEditor": "none",
  }),
);

const expected = [];

for (const entry of (
  await readdir(path.join(home, "reviews"), { withFileTypes: true })
).filter((candidate) => candidate.isDirectory())) {
  let record;

  try {
    record = JSON.parse(
      await readFile(
        path.join(home, "reviews", entry.name, "review.json"),
        "utf8",
      ),
    );
  } catch (error) {
    console.warn(`${entry.name}: unreadable review.json (${error.message})`);
    continue;
  }

  if (record.visibility === "system") continue;
  expected.push({
    uuid: entry.name,
    title: record.title,
    published: Boolean(record.presentedDocumentRevision),
  });
}

console.log(
  `${expected.length} reviews in the copied home, ${expected.filter((review) => review.published).length} published`,
);

const app = spawn("bash", [path.join(appRoot, "scripts/run.sh")], {
  cwd: appRoot,
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let appLog = "";

app.stdout.on("data", (chunk) => {
  appLog = (appLog + chunk).slice(-200000);
});

app.stderr.on("data", (chunk) => {
  appLog = (appLog + chunk).slice(-200000);
});

const stop = () => {
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch {
    /* Already exited. */
  }
};

process.on("exit", stop);

async function until(run, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let error;

  while (Date.now() < deadline) {
    try {
      const value = await run();

      if (value) return value;
    } catch (caught) {
      error = caught;
    }

    if (app.exitCode !== null)
      throw new Error(
        `Desktop exited (${app.exitCode}): ${appLog.slice(-5000)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out: ${label} (${error?.message ?? "not ready"})`);
}

const discovery = await until(async () => {
  const value = JSON.parse(
    await readFile(path.join(home, "review-desktop/server.json"), "utf8"),
  );

  const health = await (await fetch(`${value.url}/health`)).json();

  return health.ok && health.desktopAttached ? value : null;
}, "attached Desktop server");

const api = async (route, method = "GET", body) => {
  const response = await fetch(new URL(route, discovery.url), {
    method,
    headers: {
      "x-review-token": discovery.token,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return {
    status: response.status,
    value: await response.json().catch(() => null),
  };
};

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

const pageErrors = [];

const watch = (page) => {
  page.on("pageerror", (error) =>
    pageErrors.push(`${page.url()}: ${error.message}`),
  );
};

for (const page of browser.contexts().flatMap((context) => context.pages()))
  watch(page);

browser.on("page", watch);

// Listing Home starts the sweep, exactly as the Desktop does on its own.
await api("/reviews");

const results = [];

for (const review of expected) {
  const row = {
    uuid: review.uuid,
    title: review.title,
    published: review.published,
  };

  try {
    if (!review.published) {
      const legacy = await api("/reviews");
      assert.ok(
        legacy.value.reviews.some((item) => item.uuid === review.uuid),
        "never-published review stays on the legacy list",
      );
      row.outcome = "legacy (never published)";
    } else {
      const snapshot = await until(async () => {
        await api("/reviews");
        const candidate = await api(`/reviews-api/${review.uuid}?full=true`);

        if (candidate.status === 200) return candidate.value;

        // A review whose repository is gone stays legacy on purpose.
        const legacy = await api("/reviews");

        const stillLegacy = legacy.value.reviews.find(
          (item) => item.uuid === review.uuid,
        );

        return stillLegacy && !stillLegacy.available
          ? { unavailable: true }
          : null;
      }, `${review.uuid} imported`);

      if (snapshot.unavailable) {
        row.outcome = "legacy (repository unavailable)";
      } else {
        const legacy = await api("/reviews");
        assert.ok(
          !legacy.value.reviews.some((item) => item.uuid === review.uuid),
          "imported review left the legacy list",
        );
        const opened = await api(`/reviews/${review.uuid}/open`, "POST", {});
        assert.equal(opened.status, 409);
        assert.equal(opened.value?.code, "imported");

        const page = await until(async () => {
          for (const candidate of browser
            .contexts()
            .flatMap((context) => context.pages()))
            if (
              (await candidate
                .locator(".review-canvas-root [data-review-api]")
                .count()
                .catch(() => 0)) > 0 &&
              (await candidate
                .getByRole("heading", { name: snapshot.title, exact: true })
                .isVisible()
                .catch(() => false))
            )
              return candidate;

          return null;
        }, `JSON canvas for ${snapshot.title}`);

        const canvas = page.locator(".review-canvas-root");
        assert.doesNotMatch(await canvas.innerText(), /Layout failed:/);
        await page.screenshot({ path: path.join(out, `${review.uuid}.png`) });

        const warnings =
          snapshot.document[0]?.type === "callout" &&
          snapshot.document[0].title === "Imported from the MDX review";

        row.outcome = `imported v${snapshot.version}, ${snapshot.document.length} blocks${warnings ? ", with import warnings" : ""}`;
      }
    }
  } catch (error) {
    row.outcome = `FAIL: ${error.message}`;
  }

  results.push(row);
  console.log(`${row.uuid}  ${row.outcome}  ${row.title}`);
}

const failures = results.filter((row) => row.outcome.startsWith("FAIL"));

await writeFile(
  path.join(out, "report.json"),
  JSON.stringify({ results, pageErrors }, null, 2),
);

await writeFile(path.join(out, "app.log"), appLog);

await browser.close().catch(() => {});

stop();

if (pageErrors.length) {
  console.error(`renderer page errors:\n${pageErrors.join("\n")}`);
  process.exit(1);
}

if (failures.length) {
  console.error(`${failures.length} review(s) failed`);
  process.exit(1);
}

console.log(`All ${results.length} reviews passed; screenshots in ${out}`);

process.exit(0);
