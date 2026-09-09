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

import { DEFAULT_HOSTED_ORIGIN } from "./trace-storage/config";
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
      { repositoryId: 1, name: "Acme/App", origin: DEFAULT_HOSTED_ORIGIN },
      devHome,
    );
    const config = await readTraceUserConfig(devHome);
    expect(findTraceRepository(config, "acme/app")).toMatchObject({
      repositoryId: 1,
      enabledOrigins: [DEFAULT_HOSTED_ORIGIN],
    });
    expect((await stat(traceUserConfigPath(devHome))).mode & 0o777).toBe(0o600);
    expect(await denyTraceRepository({ name: "ACME/app" }, devHome)).toBe(true);
    expect(
      findTraceRepository(await readTraceUserConfig(devHome), "acme/app"),
    ).toBeNull();
  });

  it("keeps one entry per repository and appends origins", async () => {
    await allowTraceRepository(
      { repositoryId: 1, name: "Acme/App", origin: "https://one.dev.fast" },
      devHome,
    );
    await allowTraceRepository(
      {
        repositoryId: 1,
        name: "acme/renamed",
        origin: "https://Two.dev.fast/",
      },
      devHome,
    );
    const config = await readTraceUserConfig(devHome);
    expect(config.repositories).toEqual([
      expect.objectContaining({
        repositoryId: 1,
        name: "acme/renamed",
        enabledOrigins: ["https://one.dev.fast", "https://two.dev.fast"],
      }),
    ]);
  });

  it("treats a missing enabledOrigins as the default origin and drops bad ones", async () => {
    const filePath = traceUserConfigPath(devHome);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        repositories: [
          { repositoryId: 1, name: "acme/app" },
          {
            repositoryId: 2,
            name: "acme/other",
            enabledOrigins: [
              "https://app.dev.fast/path",
              "https://ok.dev.fast",
            ],
          },
        ],
      }),
    );
    const config = await readTraceUserConfig(devHome);
    expect(config.repositories.map((entry) => entry.enabledOrigins)).toEqual([
      [DEFAULT_HOSTED_ORIGIN],
      ["https://ok.dev.fast"],
    ]);
    await expect(
      allowTraceRepository(
        { repositoryId: 3, name: "acme/x", origin: "https://app.dev.fast/x" },
        devHome,
      ),
    ).rejects.toThrow(/origin/);
  });

  it("keeps the pointer, stores, and unknown fields around consent writes", async () => {
    const filePath = traceUserConfigPath(devHome);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        "current-store": "s3",
        stores: {
          s3: {
            endpoint: "https://s3.example.invalid",
            bucket: "b",
            accessKeyId: "k",
            secretAccessKey: "s",
          },
        },
        future: 1,
      }),
    );
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: DEFAULT_HOSTED_ORIGIN },
      devHome,
    );
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 2,
      "current-store": "s3",
      stores: { s3: { bucket: "b", secretAccessKey: "s" } },
      future: 1,
      repositories: [
        expect.objectContaining({
          repositoryId: 7,
          enabledOrigins: [DEFAULT_HOSTED_ORIGIN],
        }),
      ],
    });
  });

  it("reads the unshipped version-1 file", async () => {
    const filePath = traceUserConfigPath(devHome);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        repositories: [
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
    expect(config.repositories).toEqual([
      {
        repositoryId: 2,
        name: "acme/other",
        enabledOrigins: ["https://app.dev.fast"],
        allowedAt: "2026-09-01T00:00:00Z",
      },
    ]);
  });
});
