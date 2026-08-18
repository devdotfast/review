import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
