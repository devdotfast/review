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

  it("reads an absent file as no configuration", () => {
    const file = readTraceConfigFile({ env });
    expect(file).toMatchObject({ source: "absent", config: null });
    expect(file.path).toBe(path.join(home, ".dev", "trace", "config.json"));
    expect(file.error).toBeUndefined();
  });

  it("reads the unshipped version-1 file as consent only", () => {
    const filePath = traceConfigPath({ env });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
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
    expect(file.config?.storage).toBeUndefined();
    expect(file.config?.direct).toBeUndefined();
    expect(file.config?.repositories).toEqual([
      {
        repositoryId: 42,
        name: "acme/widgets",
        store: "https://app.dev.fast",
        allowedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("reports malformed files instead of ignoring them", () => {
    const filePath = traceConfigPath({ env });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json");
    expect(readTraceConfigFile({ env }).error).toContain("not valid JSON");

    writeFileSync(
      filePath,
      JSON.stringify({ version: 2, direct: { endpoint: "https://x" } }),
    );
    const incomplete = readTraceConfigFile({ env });
    expect(incomplete.config).toBeNull();
    expect(incomplete.error).toContain("direct.bucket");

    writeFileSync(filePath, JSON.stringify({ version: 3 }));
    expect(readTraceConfigFile({ env }).error).toContain("invalid");
  });

  it("writes privately, preserves unknown fields, and refuses concurrent edits", async () => {
    const filePath = traceConfigPath({ env });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 2, future: { keep: true } }),
    );
    const file = readTraceConfigFile({ env });
    await writeTraceConfigFile(file, {
      version: 2,
      storage: { mode: "direct" },
      direct: {
        endpoint: "https://s3.example.invalid",
        bucket: "traces",
        accessKeyId: "key",
        secretAccessKey: "secret",
        capture: { enabled: true, autoActivateRepositories: true },
      },
    });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      future: { keep: true },
      version: 2,
      storage: { mode: "direct" },
      direct: {
        endpoint: "https://s3.example.invalid",
        bucket: "traces",
        accessKeyId: "key",
        secretAccessKey: "secret",
        capture: { enabled: true, autoActivateRepositories: true },
      },
    });

    // The first read is now stale; a write based on it must be refused.
    await expect(
      writeTraceConfigFile(file, { version: 2, storage: { mode: "direct" } }),
    ).rejects.toThrow(/changed while it was being updated/);
    expect(JSON.parse(readFileSync(filePath, "utf8")).direct.bucket).toBe(
      "traces",
    );
  });
});
