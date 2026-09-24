import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  updateWindowsUserPath,
  windowsCliShim,
  windowsUserPathContains,
} from "../../../packages/review/src/windows-cli.ts";

function registryPath(key) {
  try {
    const output = execFileSync("reg.exe", ["query", key, "/v", "Path"], {
      encoding: "utf8",
    });

    return output.match(/^\s*Path\s+REG_\w+\s*(.*)$/im)?.[1] ?? "";
  } catch {
    return "";
  }
}

// Exercise cmd.exe's real expansion rules, including paths with metacharacters.
test(
  "Windows launcher preserves arguments, its exit code, and paths with spaces",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "Whiteboard %literal% & ! space "),
    );

    try {
      const cli = path.join(root, "cli.cjs");
      const shim = path.join(root, "whiteboard.cmd");
      await writeFile(
        cli,
        "console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.DEV_REVIEW_HOME}));process.exit(7)",
      );
      await writeFile(shim, windowsCliShim(cli, process.execPath, root));
      let result;

      try {
        await promisify(execFile)(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", '""%WHITEBOARD_TEST_SHIM%" "two words" "a&b""'],
          {
            windowsVerbatimArguments: true,
            env: {
              ...process.env,
              DEV_REVIEW_HOME: "chosen-home",
              WHITEBOARD_TEST_SHIM: shim,
            },
          },
        );
        assert.fail("must preserve the CLI exit code");
      } catch (error) {
        result = error;
      }

      assert.equal(result.code, 7);
      assert.deepEqual(JSON.parse(result.stdout), {
        args: ["two words", "a&b"],
        home: "chosen-home",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "adds and removes only the Whiteboard-owned user PATH entry",
  { skip: process.platform !== "win32" || process.env.CI !== "true" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "Whiteboard PATH test "));
    const pathKey = "HKCU\\Environment";
    const ownerKey = "HKCU\\Software\\dev.fast\\Whiteboard\\CLI";
    const originalPath = registryPath(pathKey);
    let attempted = false;

    try {
      attempted = true;
      await updateWindowsUserPath(root);

      assert.ok(
        registryPath(pathKey)
          .split(";")
          .some((entry) => entry.toLowerCase() === root.toLowerCase()),
      );
      assert.equal(registryPath(ownerKey), root);
      assert.equal(await windowsUserPathContains(root), true);

      await updateWindowsUserPath(root, true);
      attempted = false;
      assert.equal(registryPath(pathKey), originalPath);
      assert.equal(registryPath(ownerKey), "");
      assert.equal(await windowsUserPathContains(root), false);
    } finally {
      if (attempted) await updateWindowsUserPath(root, true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
