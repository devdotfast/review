import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allowTraceRepository,
  denyTraceRepository,
  findTraceRepository,
  readTraceUserConfig,
  traceUserConfigPath,
} from "./trace-user-config";

describe("trace user config", () => {
  let devHome: string;

  beforeEach(async () => {
    devHome = await mkdtemp(path.join(os.tmpdir(), "review-trace-consent-"));
  });

  afterEach(async () => {
    await rm(devHome, { recursive: true, force: true });
  });

  it("adds, finds case-insensitively, and removes entries", async () => {
    await allowTraceRepository(
      { repositoryId: 1, name: "Acme/App", store: "https://app.dev.fast" },
      devHome,
    );
    const config = await readTraceUserConfig(devHome);
    expect(findTraceRepository(config, "acme/app")?.repositoryId).toBe(1);
    expect((await stat(traceUserConfigPath(devHome))).mode & 0o777).toBe(0o600);
    expect(await denyTraceRepository("ACME/app", devHome)).toBe(true);
    expect(
      findTraceRepository(await readTraceUserConfig(devHome), "acme/app"),
    ).toBeNull();
  });

  it("replaces an entry with the same name or the same repository at one store", async () => {
    await allowTraceRepository(
      { repositoryId: 1, name: "Acme/App", store: "https://one.dev.fast" },
      devHome,
    );
    await allowTraceRepository(
      { repositoryId: 1, name: "acme/app", store: "https://two.dev.fast" },
      devHome,
    );
    await allowTraceRepository(
      { repositoryId: 1, name: "acme/renamed", store: "https://Two.dev.fast/" },
      devHome,
    );
    const config = await readTraceUserConfig(devHome);
    expect(config.repositories).toEqual([
      expect.objectContaining({
        repositoryId: 1,
        name: "acme/renamed",
        store: "https://two.dev.fast",
      }),
    ]);
  });

  it("keeps the storage selection and direct profile around consent writes", async () => {
    const filePath = traceUserConfigPath(devHome);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        storage: { mode: "direct" },
        direct: {
          endpoint: "https://s3.example.invalid",
          bucket: "b",
          accessKeyId: "k",
          secretAccessKey: "s",
        },
        future: 1,
      }),
    );
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", store: "https://app.dev.fast" },
      devHome,
    );
    const written = JSON.parse(await readFile(filePath, "utf8"));
    expect(written).toMatchObject({
      version: 2,
      storage: { mode: "direct" },
      direct: { bucket: "b", secretAccessKey: "s" },
      future: 1,
      repositories: [expect.objectContaining({ repositoryId: 7 })],
    });
  });

  it("reads the unshipped version-1 file and drops entries that name no bare origin", async () => {
    const filePath = traceUserConfigPath(devHome);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        repositories: [
          {
            repositoryId: 1,
            name: "acme/app",
            store: "https://app.dev.fast/path",
            allowedAt: "2026-09-01T00:00:00Z",
          },
          {
            repositoryId: 2,
            name: "acme/other",
            store: "https://app.dev.fast",
            allowedAt: "2026-09-01T00:00:00Z",
          },
        ],
      }),
    );
    const config = await readTraceUserConfig(devHome);
    expect(config.repositories.map((entry) => entry.repositoryId)).toEqual([2]);
    await expect(
      allowTraceRepository(
        { repositoryId: 3, name: "acme/x", store: "https://app.dev.fast/x" },
        devHome,
      ),
    ).rejects.toThrow(/origin/);
  });
});
