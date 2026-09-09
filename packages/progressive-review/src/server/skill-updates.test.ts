import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { reviewCliInstallResyncRequest } from "../../../../apps/review-desktop/code-oss/src/vs/review/common/reviewCliInstall";
import { collectingWritable } from "../cli-output";
import { readSkillVersion, runInstall } from "../install";
import {
  applyCliInstall,
  cliInstallStampPath,
  installFingerprint,
  resolveCliInstallStatus,
} from "./cli-install";
import { writePrivateJsonAtomic } from "./desktop-paths";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const workspace = path.resolve(import.meta.dirname, "../../../..");
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "review-skill-upgrade-"));
  roots.push(root);
  const homeDir = path.join(root, "home");
  await mkdir(homeDir);
  const env = {
    DEV_REVIEW_HOME: path.join(homeDir, ".dev"),
    PATH: "",
    TRACE_R2_MODE: "mock",
  };
  const packageRoot = path.join(root, "runtime");
  await cp(
    path.join(workspace, "packages/progressive-review/skills"),
    path.join(packageRoot, "skills"),
    { recursive: true },
  );
  await cp(
    path.join(workspace, "packages/progressive-review/plugins"),
    path.join(packageRoot, "plugins"),
    { recursive: true },
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    '{"version":"0.0.1"}',
  );
  const stampVersion = async (version: string) => {
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { stampReviewSkills } from "./apps/review-desktop/scripts/stage-review-runtime.mjs"; await stampReviewSkills(process.argv[1], process.argv[2]);',
        packageRoot,
        version,
      ],
      { cwd: workspace },
    );
  };
  await stampVersion("1.0.0");
  const input = { homeDir, env, packageRoot, shim: false };
  const skill = (name = "dev-review", rootName = ".agents") =>
    path.join(homeDir, rootName, "skills", name, "SKILL.md");
  const launch = async () => {
    const status = await resolveCliInstallStatus(input);
    const request = status.stale
      ? reviewCliInstallResyncRequest(status)
      : undefined;
    if (!request) return;
    return applyCliInstall({
      ...input,
      ...request,
      targets: [...request.targets],
    });
  };
  return { ...input, input, skill, stampVersion, launch };
}

describe("packaged skill updates", () => {
  it("upgrades generated directories, removes local edits, and performs no writes on a second launch", async () => {
    const f = await fixture();
    expect(
      (await applyCliInstall({ ...f.input, targets: ["codex", "pi"] })).code,
    ).toBe(0);
    const supporting = path.join(path.dirname(f.skill()), "local.txt");
    await writeFile(supporting, "local edits");
    await writeFile(
      f.skill(),
      (await readFile(f.skill(), "utf8")) + "\nlocal edit\n",
    );
    await f.stampVersion("1.1.0");
    expect((await f.launch())?.code).toBe(0);
    expect(await readSkillVersion(f.skill(), "dev-review")).toBe("1.1.0");
    expect(await readFile(f.skill(), "utf8")).not.toContain("local edit");
    await expect(stat(supporting)).rejects.toMatchObject({ code: "ENOENT" });
    const before = await stat(f.skill());
    const stampBefore = await readFile(cliInstallStampPath(f.env), "utf8");
    expect(await f.launch()).toBeUndefined();
    expect((await stat(f.skill())).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(cliInstallStampPath(f.env), "utf8")).toBe(
      stampBefore,
    );
    expect((await resolveCliInstallStatus(f.input)).skills).toHaveLength(4);
  });

  it("does not let a one-agent install hide another agent's old skills", async () => {
    const f = await fixture();
    await applyCliInstall({ ...f.input, targets: ["codex", "claude"] });
    const fingerprint = await installFingerprint(f.packageRoot);
    await f.stampVersion("2.0.0");
    expect(await installFingerprint(f.packageRoot)).toBe(fingerprint);
    await applyCliInstall({ ...f.input, targets: ["codex"] });
    const before = await stat(f.skill());
    expect((await resolveCliInstallStatus(f.input)).stale).toBe(true);
    expect((await f.launch())?.code).toBe(0);
    expect(
      await readSkillVersion(f.skill("dev-review", ".claude"), "dev-review"),
    ).toBe("2.0.0");
    expect((await stat(f.skill())).mtimeMs).toBe(before.mtimeMs);
  });

  it("migrates legacy metadata, repairs missing skills, and supports rollbacks", async () => {
    const f = await fixture();
    await applyCliInstall({ ...f.input, targets: ["codex"] });
    await writeFile(
      f.skill(),
      "---\nname: dev-review\ndescription: legacy\n---\nlegacy",
    );
    await rm(path.dirname(f.skill("dev-review-map")), { recursive: true });
    expect((await f.launch())?.code).toBe(0);
    expect(
      await readSkillVersion(f.skill("dev-review-map"), "dev-review-map"),
    ).toBe("1.0.0");
    await f.stampVersion("0.9.0");
    expect((await f.launch())?.code).toBe(0);
    expect(await readSkillVersion(f.skill(), "dev-review")).toBe("0.9.0");
  });

  it.each(["declined", "skipped", "absent"])(
    "does not enroll terminal installs with %s Desktop consent",
    async (consent) => {
      const f = await fixture();
      const sink = collectingWritable([]);
      await runInstall({
        ...f.input,
        targets: ["codex"],
        stdout: sink,
        stderr: sink,
      });
      if (consent !== "absent")
        await writePrivateJsonAtomic(cliInstallStampPath(f.env), {
          consent,
          updatedAt: new Date().toISOString(),
        });
      await f.stampVersion("2.0.0");
      expect(await f.launch()).toBeUndefined();
      // Even a stale startup request cannot override the current consent.
      await applyCliInstall({
        ...f.input,
        targets: ["codex"],
        autoUpdate: true,
      });
      expect(await readSkillVersion(f.skill(), "dev-review")).toBe("1.0.0");
    },
  );

  it("respects an explicit empty target list and legacy consent without targets", async () => {
    const f = await fixture();
    await applyCliInstall({ ...f.input, targets: ["codex"] });
    await f.stampVersion("2.0.0");
    const stamp = { consent: "granted", updatedAt: new Date().toISOString() };
    await writePrivateJsonAtomic(cliInstallStampPath(f.env), {
      ...stamp,
      targets: [],
    });
    expect(await f.launch()).toBeUndefined();
    await writePrivateJsonAtomic(cliInstallStampPath(f.env), stamp);
    expect((await f.launch())?.code).toBe(0);
    expect(await readSkillVersion(f.skill(), "dev-review")).toBe("2.0.0");
  });

  it("retries a failed destination without marking it current", async () => {
    const f = await fixture();
    await applyCliInstall({ ...f.input, targets: ["codex", "claude"] });
    await f.stampVersion("2.0.0");
    const claudeRoot = path.join(f.homeDir, ".claude", "skills");
    await rm(claudeRoot, { recursive: true });
    await writeFile(claudeRoot, "blocked destination");
    expect((await f.launch())?.code).toBe(1);
    const failed = await resolveCliInstallStatus(f.input);
    expect(failed.stale).toBe(true);
    expect(failed.error).toBeTruthy();
    expect(await readSkillVersion(f.skill(), "dev-review")).toBe("2.0.0");
    await rm(claudeRoot);
    expect((await f.launch())?.code).toBe(0);
    expect((await resolveCliInstallStatus(f.input)).error).toBeUndefined();
    expect(
      await readSkillVersion(f.skill("dev-review", ".claude"), "dev-review"),
    ).toBe("2.0.0");
  });

  it("serializes concurrent installs without losing selected agents", async () => {
    const f = await fixture();
    const results = await Promise.all([
      applyCliInstall({ ...f.input, targets: ["codex"] }),
      applyCliInstall({ ...f.input, targets: ["claude"] }),
    ]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(
      (await resolveCliInstallStatus(f.input)).stamp?.targets?.sort(),
    ).toEqual(["claude", "codex"]);
  });
  it("serializes independent installer processes", async () => {
    const f = await fixture();
    const code = `import { applyCliInstall } from "./packages/progressive-review/src/server/cli-install.ts";
      const result = await applyCliInstall({ homeDir: process.argv[1], packageRoot: process.argv[2], env: { DEV_REVIEW_HOME: process.argv[3], PATH: "" }, targets: [process.argv[4]], shim: false });
      if (result.code !== 0) throw new Error(result.output);`;
    await Promise.all(
      ["codex", "claude"].map((target) =>
        execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            code,
            f.homeDir,
            f.packageRoot,
            f.env.DEV_REVIEW_HOME,
            target,
          ],
          { cwd: workspace },
        ),
      ),
    );
    expect(
      (await resolveCliInstallStatus(f.input)).stamp?.targets?.sort(),
    ).toEqual(["claude", "codex"]);
  });

  it("reports invalid bundled metadata without replacing the installed skill", async () => {
    const f = await fixture();
    await applyCliInstall({ ...f.input, targets: ["codex"] });
    const source = path.join(f.packageRoot, "skills", "dev-review", "SKILL.md");
    await writeFile(
      source,
      (await readFile(source, "utf8")).replace(
        'review-version: "1.0.0"',
        'review-version: "broken"',
      ),
    );
    expect((await f.launch())?.code).toBe(1);
    expect(await readSkillVersion(f.skill(), "dev-review")).toBe("1.0.0");
    expect(
      (await resolveCliInstallStatus(f.input)).skills?.find(
        (skill) => skill.name === "dev-review",
      )?.error,
    ).toContain("no release version");
  });

  it("updates OpenCode and trace skills only for already enabled integrations", async () => {
    const f = await fixture();
    const installed = await applyCliInstall({
      ...f.input,
      targets: ["opencode"],
      trace: {
        endpoint: "mock://endpoint",
        bucket: "mock-bucket",
        key: "mock-key",
        secret: "mock-secret",
      },
    });
    expect(installed).toMatchObject({ code: 0 });
    const settingsPath = (await resolveCliInstallStatus(f.input)).trace
      .settingsPath;
    const traceBefore = await readFile(settingsPath, "utf8");
    await f.stampVersion("2.0.0");
    expect((await f.launch())?.code).toBe(0);
    const traceSkill = path.join(
      f.homeDir,
      ".config",
      "opencode",
      "skills",
      "trace-archaeology",
      "SKILL.md",
    );
    expect(await readSkillVersion(traceSkill, "trace-archaeology")).toBe(
      "2.0.0",
    );
    expect(await readFile(settingsPath, "utf8")).toBe(traceBefore);
    expect(
      (await resolveCliInstallStatus(f.input)).stamp?.fffRegistrations,
    ).toBeUndefined();
  });
});
