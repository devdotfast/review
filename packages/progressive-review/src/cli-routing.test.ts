import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSoftwareMapCliEntry } from "./map-cli-entry";

let directory: string;
let packagedEntry: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "review-cli-routing-"));
  const profile = path.join(directory, "profile");
  const discovery = path.join(profile, "review-desktop");
  mkdirSync(discovery, { recursive: true });
  const installed = path.join(directory, "installed-cli.cjs");
  writeFileSync(
    installed,
    'process.stdout.write("WRONG_INSTALLED_CLI"); process.exit(73);',
  );
  writeFileSync(
    path.join(discovery, "server.json"),
    JSON.stringify({ cliPath: installed }),
  );
  writeFileSync(
    path.join(profile, "review.db"),
    "untouched legacy shared database",
  );
  writeFileSync(path.join(profile, "review.mdx"), "untouched legacy review");
  packagedEntry = path.join(directory, "dist", "cli.js");
  await build({
    entryPoints: [path.join(import.meta.dirname, "cli.ts")],
    outfile: packagedEntry,
    bundle: true,
    platform: "node",
    format: "esm",
    external: [
      "./cli-runner.js",
      "./host/host-cli.js",
      "./host/host-mcp.js",
      "./tutorial-thread-cli.js",
    ],
    logLevel: "silent",
  });
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  env = { ...process.env, DEV_REVIEW_HOME: profile };
  delete env.DEV_FAST_REVIEW_CLI_NO_DELEGATE;
  delete env.DEV_FAST_REVIEW_CLI_DELEGATED;
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("public Review CLI ownership boundary", () => {
  it.each([
    ["scaffold"],
    ["--json", "info"],
    ["publish"],
    ["present"],
    ["threads", "list"],
    ["map", "open", "HEAD"],
    ["migrate", "apply"],
    ["repair"],
    ["rebind", "main"],
    ["document", "get"],
    ["wait"],
    ["wait-codex", "old-review"],
    ["stop-hook"],
    ["app", "pick"],
    ["app", "--review=old-review"],
    ["help", "scaffold"],
  ])(
    "refuses obsolete %j through the packaged entry without touching old data or invoking discovered binaries",
    (...argv) => {
      const result = spawnSync(process.execPath, [packagedEntry, ...argv], {
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("WRONG_INSTALLED_CLI");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_VERSION", retryable: false },
      });
      expect(result.stderr).toBe("");
      expect(
        readFileSync(path.join(env.DEV_REVIEW_HOME!, "review.db"), "utf8"),
      ).toBe("untouched legacy shared database");
      expect(
        readFileSync(path.join(env.DEV_REVIEW_HOME!, "review.mdx"), "utf8"),
      ).toBe("untouched legacy review");
    },
  );

  it("shows API-first usage from the packaged entry without desktop discovery or legacy runtime imports", () => {
    const result = spawnSync(process.execPath, [packagedEntry, "--help"], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("host command <operation>");
    expect(result.stdout).toContain("only app launch starts Desktop");
    expect(result.stdout).not.toContain("WRONG_INSTALLED_CLI");
  });

  it("refuses the old standalone map entry with the same API guidance", async () => {
    const stdout = new PassThrough();
    await expect(
      runSoftwareMapCliEntry({
        args: ["open", "HEAD"],
        cwd: directory,
        env,
        stdout,
        stderr: new PassThrough(),
      }),
    ).resolves.toBe(1);
    expect(stdout.read().toString()).toContain("map.create/map.mutate");
  });
});
