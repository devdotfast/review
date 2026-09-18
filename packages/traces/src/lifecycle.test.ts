import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("the installed SessionEnd hook uploads through the standalone sync entry", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "standalone-lifecycle-"));
  const cwd = path.join(home, "repo");
  const bucket = path.join(home, "bucket");
  const devHome = path.join(home, ".dev");
  const session = "docker-standalone-lifecycle-0001";

  const env = {
    ...process.env,
    HOME: home,
    DEV_REVIEW_HOME: devHome,
    PATH: `${path.join(home, ".local/bin")}:${process.env.PATH}`,
    TRACE_R2_MODE: "mock",
    TRACE_R2_MOCK_DIR: bucket,
    DEV_TRACES_NO_MODIFY_PATH: "1",
    GITHUB_REPOSITORY: "",
  };

  const run = (file: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        file,
        args,
        { cwd, env, timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`));
          else resolve(stdout);
        },
      );

      child.stdin?.end();
    });

  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(devHome, "trace"), { recursive: true });
    await mkdir(path.join(home, ".codex/sessions"), { recursive: true });
    await writeFile(
      path.join(devHome, "trace/config.json"),
      JSON.stringify({
        version: 2,
        "current-store": "s3",
        stores: {
          s3: {
            endpoint: "mock://endpoint",
            bucket: "fixture",
            accessKeyId: "fixture",
            secretAccessKey: "fixture",
            capture: { enabled: true, autoActivateRepositories: true },
          },
        },
      }),
    );

    const transcript =
      JSON.stringify({ type: "session_meta", payload: { id: session, cwd } }) +
      "\n" +
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Synthetic standalone lifecycle",
        },
      }) +
      "\n";

    await writeFile(
      path.join(home, `.codex/sessions/rollout-fixture-${session}.jsonl`),
      transcript,
    );
    await run("git", ["init", "-q"]);
    await run("git", [
      "remote",
      "add",
      "origin",
      "https://github.com/fixture/traces.git",
    ]);
    await run(process.execPath, [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "install",
      "--all-harnesses",
    ]);

    const settings = JSON.parse(
      await readFile(path.join(home, ".claude/settings.json"), "utf8"),
    );

    for (const event of ["SessionStart", "SessionEnd"]) {
      await run("/bin/sh", [
        "-c",
        `${settings.hooks[event][0].hooks[0].command} --session ${session}`,
      ]);
    }

    const uploaded = path.join(bucket, "by-session", session, "trace.jsonl");
    await expect
      .poll(async () => readFile(uploaded, "utf8").catch(() => ""), {
        timeout: 5000,
      })
      .toBe(transcript);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
