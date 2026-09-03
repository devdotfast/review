import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  allowTraceRepository,
  denyTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
  traceUserConfigPath,
} from "./trace-user-config";

describe("trace user config", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "review-trace-config-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("adds, finds case-insensitively, and removes entries", async () => {
    vi.stubEnv("DEV_REVIEW_HOME", tmp);
    await allowTraceRepository({
      repositoryId: 1,
      name: "Acme/App",
      store: "https://app.dev.fast",
    });
    const config = await readTraceUserConfig();
    expect(findTraceRepository(config, "acme/app")?.repositoryId).toBe(1);
    expect((await stat(traceUserConfigPath())).mode & 0o777).toBe(0o600);
    expect(await denyTraceRepository("ACME/app")).toBe(true);
    expect(
      findTraceRepository(await readTraceUserConfig(), "acme/app"),
    ).toBeNull();
  });

  it("replaces an entry with the same name instead of duplicating", async () => {
    vi.stubEnv("DEV_REVIEW_HOME", tmp);
    await allowTraceRepository({
      repositoryId: 1,
      name: "Acme/App",
      store: "https://one.dev.fast",
    });
    await allowTraceRepository({
      repositoryId: 1,
      name: "acme/app",
      store: "https://two.dev.fast",
    });
    const config = await readTraceUserConfig();
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0]?.store).toBe("https://two.dev.fast");
  });

  it("rejects a config with an unknown version", async () => {
    vi.stubEnv("DEV_REVIEW_HOME", tmp);
    const configPath = traceUserConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ version: 2, repositories: [] }),
      "utf8",
    );
    await expect(readTraceUserConfig()).rejects.toThrow(configPath);

    await writeFile(configPath, "null", "utf8");
    await expect(readTraceUserConfig()).rejects.toThrow(configPath);
  });
});
