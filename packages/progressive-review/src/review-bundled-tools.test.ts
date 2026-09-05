import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureBundledRustAnalyzer,
  reviewToolsRoot,
  stagedToolPath,
} from "./review-bundled-tools";

describe("bundled Review tools", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((entry) => rm(entry, { recursive: true, force: true })),
    );
  });

  async function prepareRustAnalyzerEnv() {
    const devHome = await mkdtemp(path.join(tmpdir(), "review-tools-home-"));
    cleanup.push(devHome);
    const rustAnalyzer = path.join(devHome, "desktop-rust-analyzer");
    await writeFile(rustAnalyzer, "#!/bin/sh\necho rust-analyzer 1.0\n");
    await chmod(rustAnalyzer, 0o755);
    const env = {
      ...process.env,
      DEV_REVIEW_HOME: devHome,
      DEV_FAST_REVIEW_RUST_ANALYZER: rustAnalyzer,
    };
    const executable = stagedToolPath(env, "rust-analyzer");
    const destination = path.dirname(executable);
    const lock = `${destination}.install-lock`;
    await mkdir(path.dirname(destination), { recursive: true });
    return { env, lock };
  }

  it("reclaims an orphaned install lock (no owner.json) and stages", async () => {
    const { env, lock } = await prepareRustAnalyzerEnv();
    await mkdir(lock, { recursive: true });
    const aged = new Date(Date.now() - 2_000);
    await utimes(lock, aged, aged);

    const started = Date.now();
    await expect(ensureBundledRustAnalyzer({ env })).resolves.toBe("staged");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(lock)).toBe(false);
  });

  it("reclaims an install lock whose owning process is dead", async () => {
    const { env, lock } = await prepareRustAnalyzerEnv();
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647 }),
      "utf8",
    );
    const fresh = new Date();
    await utimes(lock, fresh, fresh);

    const started = Date.now();
    await expect(ensureBundledRustAnalyzer({ env })).resolves.toBe("staged");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(lock)).toBe(false);
  });

  it("does not steal an install lock from a live owner, then proceeds once released", async () => {
    const { env, lock } = await prepareRustAnalyzerEnv();
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );
    const fresh = new Date();
    await utimes(lock, fresh, fresh);

    const pending = ensureBundledRustAnalyzer({ env });
    await delay(600);
    expect(existsSync(lock)).toBe(true);
    await rm(lock, { recursive: true, force: true });

    await expect(pending).resolves.toBe("staged");
    expect(existsSync(lock)).toBe(false);
  });

  it("stages Rust Analyzer for standalone CLI processes", async () => {
    const devHome = await mkdtemp(path.join(tmpdir(), "review-tools-home-"));
    cleanup.push(devHome);
    const rustAnalyzer = path.join(devHome, "desktop-rust-analyzer");
    await writeFile(rustAnalyzer, "#!/bin/sh\necho rust-analyzer 1.0\n");
    await chmod(rustAnalyzer, 0o755);
    const env = {
      ...process.env,
      DEV_REVIEW_HOME: devHome,
      DEV_FAST_REVIEW_RUST_ANALYZER: rustAnalyzer,
    };

    await expect(ensureBundledRustAnalyzer({ env })).resolves.toBe("staged");
    await expect(ensureBundledRustAnalyzer({ env })).resolves.toBe("fresh");
    const staged = stagedToolPath(env, "rust-analyzer");
    const [sourceBytes, stagedBytes, stagedMetadata] = await Promise.all([
      readFile(rustAnalyzer),
      readFile(staged),
      stat(staged),
    ]);
    expect(stagedBytes).toEqual(sourceBytes);
    expect(stagedMetadata.mode & 0o111).not.toBe(0);
    expect(createHash("sha256").update(stagedBytes).digest("hex")).toBe(
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(path.dirname(staged), "review-tool.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      tool: "rust-analyzer",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(reviewToolsRoot(env)).toBe(path.join(devHome, "review-tools"));
  });
});
