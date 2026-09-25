import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const app = process.env.APP;

if (!/^review(?:-preview)?$/.test(app ?? ""))
  throw new Error("Set APP to review or review-preview");

const state = await mkdtemp(path.join(os.tmpdir(), "whiteboard-install-"));

const portServer = createServer();

await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));

const port = portServer.address().port;

await new Promise((resolve) => portServer.close(resolve));

let output = "";

const child = spawn(
  `/usr/bin/${app}-desktop`,
  [
    `--user-data-dir=${state}/profile`,
    `--extensions-dir=${state}/extensions`,
    `--remote-debugging-port=${port}`,
  ],
  {
    env: {
      ...process.env,
      DEV_REVIEW_HOME: `${state}/reviews`,
      DEV_REVIEW_IMPORT_FROM: "none",
      DO_NOT_TRACK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.on("data", (data) => {
  output += data;
});

child.stderr.on("data", (data) => {
  output += data;
});

let exited = false;

const exit = new Promise((resolve) => {
  child.once("error", (error) => {
    output += String(error);
    exited = true;
    resolve();
  });
  child.once("exit", () => {
    exited = true;
    resolve();
  });
});

async function renderedOnboarding() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });

  const pages = await response.json();

  const page = pages.find(
    (page) => page.type === "page" && page.url.startsWith("vscode-file://"),
  );

  if (!page?.webSocketDebuggerUrl) return false;
  const socket = new WebSocket(page.webSocketDebuggerUrl);

  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);

      const finish = (value) => {
        clearTimeout(timer);
        resolve(value);
      };

      socket.addEventListener("error", () => finish(false));
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression:
                'Boolean(document.querySelector(".review-onboarding-headline")?.getBoundingClientRect().height)',
              returnByValue: true,
            },
          }),
        ),
      );
      socket.addEventListener("message", ({ data }) => {
        const result = JSON.parse(data);

        if (result.id === 1) finish(result.result?.result?.value === true);
      });
    });
  } finally {
    socket.close();
  }
}

async function serverReady() {
  const logs = `${state}/profile/logs`;

  for (const entry of await readdir(logs)) {
    const main = await readFile(`${logs}/${entry}/main.log`, "utf8").catch(
      () => "",
    );

    if (/\[Review Desktop\] server ready at https?:\/\//.test(main))
      return true;
  }

  return false;
}

try {
  const deadline = Date.now() + 180_000;
  let ready = false;

  while (Date.now() < deadline && !exited) {
    if (
      (await serverReady().catch(() => false)) &&
      (await renderedOnboarding().catch(() => false))
    ) {
      ready = true;
      break;
    }

    await delay(500);
  }

  assert.ok(
    ready,
    "Installed app did not render onboarding and start its bundled server",
  );

  if (process.env.APPARMOR_PROFILE) {
    const profile = await readFile(`/proc/${child.pid}/attr/current`, "utf8");
    assert.ok(
      profile.startsWith(`${process.env.APPARMOR_PROFILE} `),
      `Unexpected AppArmor profile: ${profile}`,
    );
  }

  console.log(
    `${app}: onboarding rendered and bundled server ready, with sandboxing enabled.`,
  );
} catch (error) {
  console.error(output.replaceAll(/"token":"[^"]*"/g, '"token":"[redacted]"'));
  throw error;
} finally {
  if (!exited) child.kill("SIGTERM");
  await Promise.race([exit, delay(5000)]);

  if (!exited) {
    child.kill("SIGKILL");
    await exit;
  }

  await rm(state, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
