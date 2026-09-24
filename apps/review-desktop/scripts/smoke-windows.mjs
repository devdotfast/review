import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mainLog(profile) {
  const root = path.join(profile, "logs");
  const sessions = await readdir(root).catch(() => []);

  return (
    await Promise.all(
      sessions.map((session) =>
        readFile(path.join(root, session, "main.log"), "utf8").catch(() => ""),
      ),
    )
  ).join("\n");
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;

  return {
    close: () => ws.close(),
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;

        const timer = setTimeout(() => {
          ws.removeEventListener("message", handler);
          reject(new Error(`CDP timeout: ${method}`));
        }, 15000);

        const handler = (event) => {
          const response = JSON.parse(event.data);

          if (response.id !== requestId) return;
          clearTimeout(timer);
          ws.removeEventListener("message", handler);

          if (response.error) reject(new Error(response.error.message));
          else resolve(response.result);
        };

        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id: requestId, method, params }));
      }),
  };
}

export async function smokeWindows(app, evidence) {
  assert.equal(process.platform, "win32");

  const product = JSON.parse(
    await readFile(path.join(app, "resources/app/product.json"), "utf8"),
  );

  const profile = await mkdtemp(
    path.join(os.tmpdir(), "Whiteboard Windows smoke "),
  );

  const executable = path.join(app, `${product.nameShort}.exe`);

  const env = {
    ...process.env,
    DEV_REVIEW_HOME: path.join(profile, "review-home"),
    DEV_REVIEW_IMPORT_FROM: "none",
  };

  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      `--extensions-dir=${path.join(profile, "extensions")}`,
      "--remote-debugging-port=0",
      "--disable-telemetry",
    ],
    { env, stdio: "ignore" },
  );

  let failure;
  child.on("error", (error) => {
    failure = error;
  });
  child.on("exit", (code) => {
    failure = new Error(`Desktop exited before verification (${code})`);
  });
  let cdp;

  try {
    const deadline = Date.now() + 180000;

    while (Date.now() < deadline) {
      if (failure) throw failure;

      const port = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(
          () => "",
        )
      ).split("\n")[0];

      try {
        if (!port) throw new Error("Waiting for DevTools");

        const pages = await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json();

        const page = pages.find(
          (page) => page.type === "page" && page.url.startsWith("vscode-file:"),
        );

        if (!page) throw new Error("Waiting for workbench");
        cdp ??= await connect(page.webSocketDebuggerUrl);

        const dom = await cdp.call("Runtime.evaluate", {
          expression: `JSON.stringify({title:document.title,visible:!!document.querySelector('.review-onboarding-headline')?.getBoundingClientRect().height,text:document.body.innerText.slice(0,500)})`,
          returnByValue: true,
        });

        const state = JSON.parse(dom.result.value);
        const log = await mainLog(profile);

        if (
          !state.visible ||
          !/\[Review Desktop\] server ready at https?:\/\//.test(log)
        )
          throw new Error("Waiting for onboarding and embedded server");
        await mkdir(evidence, { recursive: true });

        const shot = await cdp.call("Page.captureScreenshot", {
          format: "png",
        });

        await writeFile(
          path.join(
            evidence,
            `${product.quality}-${product.reviewVersion}-${product.target ?? "archive"}-desktop.png`,
          ),
          Buffer.from(shot.data, "base64"),
        );
        await writeFile(
          path.join(
            evidence,
            `${product.quality}-${product.reviewVersion}-${product.target ?? "archive"}-launch.json`,
          ),
          JSON.stringify(
            {
              quality: product.quality,
              version: product.reviewVersion,
              ...state,
            },
            null,
            2,
          ),
        );
        const runtime = path.join(app, "resources/app/review-runtime");

        const version = execFileSync(
          executable,
          [path.join(runtime, "dist/cli.js"), "version"],
          {
            env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
            encoding: "utf8",
            timeout: 30000,
          },
        );

        assert.match(version, /\d+\.\d+\.\d+/);

        const diffr = execFileSync(
          path.join(runtime, "bin/diffr.exe"),
          ["--version"],
          { encoding: "utf8", timeout: 30000 },
        );

        assert.match(diffr, /0\.1\.3/);
        const repository = path.join(profile, "repository with spaces");
        await mkdir(repository);

        const git = (...args) =>
          execFileSync("git.exe", args, {
            cwd: repository,
            encoding: "utf8",
            timeout: 30000,
          });

        git("init", "--initial-branch=main");
        const source = path.join(repository, "order.ts");
        await writeFile(source, 'export const status = "draft";\n');
        git("add", "order.ts");
        git(
          "-c",
          "user.name=Windows smoke",
          "-c",
          "user.email=ci@dev.fast",
          "commit",
          "-m",
          "Base",
        );
        const base = git("rev-parse", "HEAD").trim();
        await writeFile(source, 'export const status = "queued";\n');
        git("add", "order.ts");
        git(
          "-c",
          "user.name=Windows smoke",
          "-c",
          "user.email=ci@dev.fast",
          "commit",
          "-m",
          "Head",
        );
        const head = git("rev-parse", "HEAD").trim();

        const stream = execFileSync(
          path.join(runtime, "bin/diffr.exe"),
          [
            "--repo",
            repository,
            "--format",
            "ndjson",
            "--stream-annotations",
            base,
            head,
            "--",
          ],
          { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
        );

        const records = stream
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));

        assert.equal(records[0].type, "start");
        const complete = records.at(-1);
        assert.equal(complete.type, "complete");
        assert.equal(complete.succeeded, 1);
        assert.equal(complete.failed, 0);

        const api = (tool, input) =>
          JSON.parse(
            execFileSync(
              executable,
              [
                path.join(runtime, "dist/cli.js"),
                "api",
                tool,
                JSON.stringify(input),
              ],
              {
                env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
                cwd: repository,
                encoding: "utf8",
                timeout: 60000,
                maxBuffer: 8 * 1024 * 1024,
              },
            ),
          );

        const registered = api("session_register_repository", {
          path: repository,
        });

        const created = api("session_create", {
          commandId: randomUUID(),
          title: "Windows structural diff smoke",
          open: false,
          target: { kind: "commits", repositoryId: registered.id, base, head },
        });

        assert.ok(created.sessionId);

        const diff = api("session_diff", {
          sessionId: created.sessionId,
          format: "files",
        });

        assert.ok(JSON.stringify(diff).includes("order.ts"));

        console.log(
          JSON.stringify({
            app,
            onboarding: true,
            server: true,
            cli: version.trim(),
            diffr: diffr.trim(),
          }),
        );

        return;
      } catch (error) {
        if (Date.now() + 1000 >= deadline) throw error;
        await sleep(1000);
      }
    }

    throw new Error("Windows desktop launch timed out");
  } catch (error) {
    const log = (await mainLog(profile)).replace(
      /(token[=: ]+)[^\s,}"]+/gi,
      "$1[redacted]",
    );

    throw new Error(`${error.message}\n${log}`);
  } finally {
    cdp?.close();

    if (child.pid) {
      try {
        execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
        });
      } catch {}
    }

    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await smokeWindows(
    path.resolve(process.argv[2]),
    path.resolve(process.argv[3] ?? "artifacts/windows"),
  );
