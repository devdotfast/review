// Run after the Review package build. All configuration belongs to this fixture.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL("../packages/progressive-review/dist/cli.js", import.meta.url),
);

const root = await mkdtemp(path.join(os.tmpdir(), "review-hosted-smoke-"));

try {
  const devHome = path.join(root, "dev-home");
  await mkdir(path.join(devHome, "review-desktop"), { recursive: true });
  await mkdir(path.join(devHome, "trace"), { recursive: true });
  const configPath = path.join(devHome, "trace/config.json");
  const config = JSON.stringify({ version: 2, "current-store": "hosted" });
  await writeFile(configPath, config);
  const oldCli = path.join(root, "old-cli.cjs");
  await writeFile(oldCli, 'process.stdout.write("old-build-answer\\n");\n');
  const discovery = path.join(devHome, "review-desktop/server.json");
  await writeFile(discovery, JSON.stringify({ cliPath: oldCli }));

  const env = {
    ...process.env,
    DEV_REVIEW_HOME: devHome,
    DO_NOT_TRACK: "1",
    DEV_FAST_REVIEW_CLI_DELEGATED: "",
    DEV_FAST_REVIEW_CLI_NO_DELEGATE: "",
    DEV_FAST_REVIEW_CLI_DIAGNOSTICS_PRINTED: "",
  };

  const run = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 20000,
    });

    assert.equal(result.status, 0, result.stderr || String(result.error));

    return result;
  };

  const info = JSON.parse(run(["version", "--verbose", "--json"]).stdout);
  assert.equal(info.effectivePath, oldCli);
  assert.equal(info.delegated, true);
  assert.equal(info.commit, null);
  const status = run(["trace", "status"]);
  assert.equal(status.stdout, "old-build-answer\n");
  assert.ok(status.stderr.includes(oldCli));
  const directEnv = { DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1" };

  const direct = JSON.parse(
    run(["version", "--verbose", "--json"], directEnv).stdout,
  );

  assert.equal(direct.delegated, false);
  assert.equal(direct.effectivePath, cli);
  assert.ok(direct.commit);
  assert.equal(run(["--version"], directEnv).stdout.trim(), direct.version);
  assert.equal(
    JSON.parse(run(["version", "--json"], directEnv).stdout).version,
    direct.version,
  );
  run(["trace", "failures", "clear", "session-not-present"], directEnv);

  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "remote",
      "add",
      "origin",
      "https://github.com/example/notice-fixture.git",
    ],
    { cwd: root },
  );

  const hook = [
    "trace",
    "hook",
    "SessionStart",
    "--session",
    "session-smoke-start",
    "--notify-skipped-capture",
  ];

  assert.match(run(hook, directEnv).stdout, /Hosted trace capture is off/);
  assert.equal(run(hook, directEnv).stdout, "");
  assert.match(
    run(["trace", "status"], directEnv).stdout,
    /S3 auto-activation applies only to the bucket/,
  );
  assert.equal(await readFile(configPath, "utf8"), config);
  const legacyEnvPath = path.join(root, "legacy.env");
  const legacySettingsPath = path.join(root, "legacy-settings.json");

  const legacyEnv =
    'TRACE_R2_ENDPOINT="https://fixture.example"\nTRACE_R2_BUCKET="fixture"\nTRACE_R2_ACCESS_KEY_ID="fixture-key"\nTRACE_R2_SECRET_ACCESS_KEY="fixture-secret"\n';

  await writeFile(legacyEnvPath, legacyEnv);

  const settings = JSON.stringify({
    version: 1,
    enabled: true,
    autoActivateRepositories: true,
  });

  await writeFile(legacySettingsPath, settings);
  const migrationHome = path.join(root, "migration-home");

  const migration = run(["trace", "config", "migrate", "--dry-run", "--json"], {
    ...directEnv,
    DEV_REVIEW_HOME: migrationHome,
    TRACE_ENV_FILE: legacyEnvPath,
    TRACE_SETTINGS_FILE: legacySettingsPath,
    TRACE_R2_MODE: "mock",
    TRACE_R2_MOCK_DIR: path.join(root, "mock-bucket"),
  });

  assert.equal(JSON.parse(migration.stdout).status, "preview");
  assert.match(migration.stderr, /auto-activation applies only to the bucket/);
  assert.equal(await readFile(legacyEnvPath, "utf8"), legacyEnv);
  assert.equal(await readFile(legacySettingsPath, "utf8"), settings);
  await assert.rejects(
    readFile(path.join(migrationHome, "trace/config.json")),
    { code: "ENOENT" },
  );
  console.log(
    "Built CLI checks passed: delegation, JSON, failure dismissal, status, and one-time notice.",
  );

  if (process.argv.includes("--claude")) {
    // Use a fresh origin to avoid consuming the manual fixture's notice marker.
    const claudeHome = path.join(root, "claude-dev-home");
    await mkdir(path.join(claudeHome, "trace"), { recursive: true });
    await writeFile(path.join(claudeHome, "trace/config.json"), config);

    const command = [
      process.execPath,
      cli,
      "trace",
      "hook",
      "SessionStart",
      "--notify-skipped-capture",
    ]
      .map((part) => `'${part.replaceAll("'", `'"'"'`)}'`)
      .join(" ");

    const settings = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
    });

    const result = spawnSync(
      "claude",
      [
        "-p",
        "Read the SessionStart hook context. Reply only with the repository name from its hosted capture notice, or MISSING if there was no notice.",
        "--setting-sources",
        "",
        "--settings",
        settings,
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
      ],
      {
        cwd: root,
        env: { ...env, ...directEnv, DEV_REVIEW_HOME: claudeHome },
        encoding: "utf8",
        timeout: 45000,
      },
    );

    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /example\/notice-fixture/);
    assert.equal(
      await readFile(path.join(claudeHome, "trace/config.json"), "utf8"),
      config,
    );
    console.log("Live Claude Code received the SessionStart notice.");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
