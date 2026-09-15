import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderTraceCommand,
  resolveTraceCommand,
  setTraceCliName,
  traceCliName,
  traceHomeDir,
} from "./trace-command";

const roots: string[] = [];

afterEach(async () => {
  setTraceCliName("review");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trace-command-"));
  roots.push(dir);

  return dir;
}

async function installFile(homeDir: string, name: string): Promise<string> {
  const installed = path.join(homeDir, ".local", "bin", name);
  await mkdir(path.dirname(installed), { recursive: true });
  await writeFile(installed, "#!/bin/sh\n");

  return installed;
}

describe("resolveTraceCommand", () => {
  it("prefers explicit, then the environment, then the installed file, then the name", async () => {
    const homeDir = await tempHome();
    const env: NodeJS.ProcessEnv = {};

    expect(
      resolveTraceCommand({
        explicit: { file: "/x/dev-traces", args: ["--a"] },
        env,
        homeDir,
      }),
    ).toEqual({ file: "/x/dev-traces", args: ["--a"] });
    expect(
      resolveTraceCommand({ explicit: "/opt/review", env, homeDir }),
    ).toEqual({ file: "/opt/review" });
    expect(
      resolveTraceCommand({
        env: { REVIEW_TRACE_COMMAND: "/env/review" },
        homeDir,
      }),
    ).toEqual({ file: "/env/review" });
    expect(resolveTraceCommand({ env, homeDir })).toEqual({ file: "review" });

    const installed = await installFile(homeDir, "review");
    expect(resolveTraceCommand({ env, homeDir })).toEqual({ file: installed });
  });

  it("probes the installed file under the configured CLI name", async () => {
    const homeDir = await tempHome();
    setTraceCliName("dev-traces");
    expect(traceCliName()).toBe("dev-traces");
    expect(resolveTraceCommand({ env: {}, homeDir })).toEqual({
      file: "dev-traces",
    });

    const installed = await installFile(homeDir, "dev-traces");
    expect(resolveTraceCommand({ env: {}, homeDir })).toEqual({
      file: installed,
    });
  });

  it("reads TRACE_HOME_DIR before the OS home", () => {
    expect(traceHomeDir({ TRACE_HOME_DIR: "/tmp/h" })).toBe("/tmp/h");
    expect(traceHomeDir({})).toBe(os.homedir());
  });
});

describe("renderTraceCommand", () => {
  it("quotes the file and every argument as separate words", () => {
    expect(renderTraceCommand({ file: "review" })).toBe("'review'");
    expect(
      renderTraceCommand({
        file: "/opt/dev traces/node",
        args: ["/x/cli.js", "it's"],
      }),
    ).toBe(`'/opt/dev traces/node' '/x/cli.js' 'it'"'"'s'`);
  });
});
