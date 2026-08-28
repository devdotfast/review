import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewCliInstallStamp } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCliInstall,
  cliInstallStampPath,
  readCliInstallStamp,
  removeCliInstall,
  resolveCliInstallStatus,
  resolveInstalledReviewAgentStatus,
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

describe("trace capture installation", () => {
  it("uses the shared installer and keeps credentials when disabled", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "review-trace-install-"));
    temporaryDirectories.push(homeDir);
    const env: NodeJS.ProcessEnv = {
      DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
      TRACE_ENV_FILE: path.join(homeDir, "trace.env"),
      TRACE_SETTINGS_FILE: path.join(homeDir, "trace-settings.json"),
      TRACE_R2_MODE: "mock",
    };
    const packageRoot = path.resolve(import.meta.dirname, "../..");

    const applied = await applyCliInstall({
      packageRoot,
      targets: [],
      homeDir,
      env,
      trace: {
        endpoint: "mock://endpoint",
        bucket: "mock-bucket",
        key: "mock-key-id",
        secret: "mock-secret-value",
      },
    });

    expect(applied.code).toBe(0);
    const status = await resolveCliInstallStatus({ packageRoot, homeDir, env });
    expect(status.trace).toMatchObject({
      enabled: true,
      configured: true,
      autoActivateRepositories: true,
      accessKeyIdPrefix: "mock-k",
    });
    expect(JSON.stringify(status)).not.toContain("mock-secret-value");
    expect(status.stamp?.traceManaged).toBe(true);

    await removeCliInstall({ targets: [], trace: true, homeDir, env });

    const disabled = await resolveCliInstallStatus({
      packageRoot,
      homeDir,
      env,
    });
    expect(disabled.trace.enabled).toBe(false);
    expect(disabled.trace.configured).toBe(true);
    expect(await readFile(env.TRACE_ENV_FILE!, "utf8")).toContain(
      "mock-secret-value",
    );
  });
});

describe("resolveInstalledReviewAgentStatus", () => {
  it("detects installed agents without invoking their CLIs", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "review-agent-status-"));
    temporaryDirectories.push(homeDir);
    const binDir = path.join(homeDir, "bin");
    const probeLog = path.join(homeDir, "agent-probes.log");
    await Promise.all([
      mkdir(binDir, { recursive: true }),
      mkdir(path.join(homeDir, ".claude", "skills", "dev-review"), {
        recursive: true,
      }),
    ]);
    await writeFile(
      path.join(homeDir, ".claude", "skills", "dev-review", "SKILL.md"),
      "---\nname: dev-review\n---\n",
    );
    const executable = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "$AGENT_PROBE_LOG"\nexit 1\n`;
    await Promise.all(
      ["claude", "codex"].map((name) =>
        writeFile(path.join(binDir, name), executable, { mode: 0o755 }),
      ),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_PROBE_LOG: probeLog,
      DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
      PATH: binDir,
    };

    const status = await resolveInstalledReviewAgentStatus({
      homeDir,
      env,
    });

    expect(status.agents).toContainEqual({
      target: "claude",
      present: true,
      installed: true,
    });
    await expect(readFile(probeLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("tracks OpenCode install state without changing Codex skills", async () => {
    const homeDir = await mkdtemp(
      path.join(tmpdir(), "review-opencode-install-"),
    );
    const packageRoot = await mkdtemp(
      path.join(tmpdir(), "review-opencode-package-"),
    );
    temporaryDirectories.push(homeDir, packageRoot);
    const env = { DEV_REVIEW_HOME: path.join(homeDir, ".dev") };
    for (const name of ["dev-review", "dev-review-map", "trace-archaeology"]) {
      const directory = path.join(packageRoot, "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: test\n---\n`,
      );
    }
    await mkdir(path.join(packageRoot, "tools"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "tools", "review.ts"),
      "// Managed by Review Desktop (@dev.fast/review). v1\n",
    );
    const codexSkill = path.join(
      homeDir,
      ".agents",
      "skills",
      "dev-review",
      "SKILL.md",
    );
    await mkdir(path.dirname(codexSkill), { recursive: true });
    await writeFile(codexSkill, "user-owned\n");

    expect(
      (
        await applyCliInstall({
          packageRoot,
          targets: ["opencode"],
          homeDir,
          env,
        })
      ).code,
    ).toBe(0);
    expect(
      await resolveCliInstallStatus({ packageRoot, homeDir, env }),
    ).toMatchObject({
      stale: false,
      stamp: { targets: ["opencode"] },
    });

    await rm(path.join(homeDir, ".config", "opencode", "tools", "review.ts"));
    expect(
      await resolveCliInstallStatus({ packageRoot, homeDir, env }),
    ).toMatchObject({
      stale: true,
      agents: expect.arrayContaining([
        expect.objectContaining({ target: "opencode", installed: false }),
      ]),
    });
    expect(
      (
        await applyCliInstall({
          packageRoot,
          targets: ["opencode"],
          homeDir,
          env,
        })
      ).code,
    ).toBe(0);

    await writeFile(
      path.join(packageRoot, "tools", "review.ts"),
      "// Managed by Review Desktop (@dev.fast/review). v2\n",
    );
    expect(
      await resolveCliInstallStatus({ packageRoot, homeDir, env }),
    ).toMatchObject({ stale: true });

    await removeCliInstall({ targets: ["opencode"], homeDir, env });
    expect(await readFile(codexSkill, "utf8")).toBe("user-owned\n");
  });
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(tmpdir(), "review-cli-install-"));
  temporaryDirectories.push(directory);
  return { DEV_REVIEW_HOME: directory };
}
