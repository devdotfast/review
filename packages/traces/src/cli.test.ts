import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("dev-traces built entry", () => {
  it("prints the package version", async () => {
    const { stdout } = await run(process.execPath, [cliPath, "--version"]);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("starts with the node shebang", async () => {
    const source = await readFile(cliPath, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
