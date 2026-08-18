import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewCliInstallStamp } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  cliInstallStampPath,
  readCliInstallStamp,
  skipCliInstall,
} from "./cli-install";
import { writePrivateJsonAtomic } from "./desktop-paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("skipCliInstall", () => {
  it("records skipped consent when no stamp exists", async () => {
    const env = await isolatedEnvironment();

    await skipCliInstall(env);

    expect(await readCliInstallStamp(cliInstallStampPath(env))).toMatchObject({
      consent: "skipped",
    });
  });

  it.each(["granted", "declined", "skipped"] as const)(
    "does not replace %s consent",
    async (consent) => {
      const env = await isolatedEnvironment();
      const stamp = {
        consent,
        updatedAt: "2026-08-09T00:00:00.000Z",
      } satisfies ReviewCliInstallStamp;
      await writePrivateJsonAtomic(cliInstallStampPath(env), stamp);

      await skipCliInstall(env);

      expect(await readCliInstallStamp(cliInstallStampPath(env))).toEqual(
        stamp,
      );
    },
  );
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-cli-install-"));
  temporaryDirectories.push(directory);
  return { DEV_REVIEW_HOME: directory };
}
