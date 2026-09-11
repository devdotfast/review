import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readTraceConfigFile,
  traceConfigPath,
  writeTraceConfigFile,
} from "./config";

describe("trace config file", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-config-"));
    env = { DEV_REVIEW_HOME: path.join(home, ".dev") };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(text: string): string {
    const filePath = traceConfigPath({ env });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, text);
    return filePath;
  }

  it("reads an absent file as no configuration", () => {
    const file = readTraceConfigFile({ env });
    expect(file).toMatchObject({ source: "absent", config: null });
    expect(file.path).toBe(path.join(home, ".dev", "trace", "config.json"));
    expect(file.error).toBeUndefined();
  });

  it("reads the unshipped version-1 file as consent enabled at each entry's store", () => {
    write(
      JSON.stringify({
        version: 1,
        repositories: [
          {
            repositoryId: 42,
            name: "acme/widgets",
            store: "https://app.dev.fast",
            allowedAt: "2026-09-01T00:00:00.000Z",
          },
          { bogus: true },
        ],
      }),
    );
    const file = readTraceConfigFile({ env });
    expect(file.source).toBe("v1");
    expect(file.config?.["current-store"]).toBeUndefined();
    expect(file.config?.stores).toBeUndefined();
    expect(file.config?.repositories).toEqual([
      {
        repositoryId: 42,
        name: "acme/widgets",
        enabledOrigins: ["https://app.dev.fast"],
        allowedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("reports malformed files instead of ignoring them", () => {
    write("{ not json");
    expect(readTraceConfigFile({ env }).error).toContain("not valid JSON");

    write(
      JSON.stringify({ version: 2, stores: { s3: { endpoint: "https://x" } } }),
    );
    const incomplete = readTraceConfigFile({ env });
    expect(incomplete.config).toBeNull();
    expect(incomplete.error).toContain("stores.s3.bucket");

    write(JSON.stringify({ version: 2, "current-store": "sideways" }));
    expect(readTraceConfigFile({ env }).error).toContain("invalid");

    write(JSON.stringify({ version: 3 }));
    expect(readTraceConfigFile({ env }).error).toContain("invalid");
  });

  it("requires the pointer when both stores are configured", () => {
    write(
      JSON.stringify({
        version: 2,
        stores: {
          s3: {
            endpoint: "https://s3.example.invalid",
            bucket: "b",
            accessKeyId: "k",
            secretAccessKey: "s",
          },
          hosted: { origin: "https://app.dev.fast" },
        },
      }),
    );
    expect(readTraceConfigFile({ env }).error).toContain("current-store");
  });

  it("serializes writers in separate processes and rejects the stale snapshot", async () => {
    write(JSON.stringify({ version: 2, future: { keep: true } }));
    const script = `
      import { readTraceConfigFile, writeTraceConfigFile } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
      const file = readTraceConfigFile();
      process.stdout.write("ready\\n");
      process.stdin.once("data", async () => {
        try {
          await writeTraceConfigFile(file, { version: 2, "current-store": process.argv[1] });
          process.exit(0);
        } catch (error) {
          process.stderr.write(error.message);
          process.exit(1);
        }
      });
    `;
    const children = ["hosted", "s3"].map((selection) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script, selection],
        {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error(stderr || "Writer exited before ready")),
        );
      });
      const done = new Promise<{ code: number | null; stderr: string }>(
        (resolve) => {
          child.once("exit", (code) => resolve({ code, stderr }));
        },
      );
      return { child, ready, done, selection };
    });
    try {
      await Promise.all(children.map(({ ready }) => ready));
      for (const { child } of children) child.stdin.end("write");
      const results = await Promise.all(children.map(({ done }) => done));
      expect(results.map(({ code }) => code).sort()).toEqual([0, 1]);
      expect(results.find(({ code }) => code === 1)?.stderr).toMatch(
        /changed while it was being updated/,
      );
      const winner = results.findIndex(({ code }) => code === 0);
      expect(
        JSON.parse(readFileSync(traceConfigPath({ env }), "utf8")),
      ).toEqual({
        version: 2,
        future: { keep: true },
        "current-store": children[winner].selection,
      });
    } finally {
      for (const { child } of children)
        if (child.exitCode === null) child.kill();
    }
  });

  it("writes privately, preserves unknown fields, and refuses concurrent edits", async () => {
    const filePath = write(
      JSON.stringify({ version: 2, future: { keep: true } }),
    );
    const file = readTraceConfigFile({ env });
    await writeTraceConfigFile(file, {
      version: 2,
      "current-store": "s3",
      stores: {
        s3: {
          endpoint: "https://s3.example.invalid",
          bucket: "traces",
          accessKeyId: "key",
          secretAccessKey: "secret",
          capture: { enabled: true, autoActivateRepositories: true },
        },
      },
      repositories: [{ repositoryId: 7, name: "acme/app" }],
    });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      future: { keep: true },
      version: 2,
      "current-store": "s3",
      stores: {
        s3: {
          endpoint: "https://s3.example.invalid",
          bucket: "traces",
          accessKeyId: "key",
          secretAccessKey: "secret",
          capture: { enabled: true, autoActivateRepositories: true },
        },
      },
      repositories: [{ repositoryId: 7, name: "acme/app" }],
    });

    // The first read is now stale; a write based on it must be refused.
    await expect(
      writeTraceConfigFile(file, { version: 2, "current-store": "s3" }),
    ).rejects.toThrow(/changed while it was being updated/);
    expect(JSON.parse(readFileSync(filePath, "utf8")).stores.s3.bucket).toBe(
      "traces",
    );
  });
});
