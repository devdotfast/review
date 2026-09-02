import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const generatorPath = fileURLToPath(
  new URL("../scripts/generate-native-source.mjs", import.meta.url),
);
const bundlerPath = fileURLToPath(
  new URL("../scripts/bundle-native-runtime.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("native Review Protocol source generation", () => {
  it("emits one self-contained source file for the Code OSS overlay", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "review-protocol-native-"),
    );
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "reviewProtocol.ts");

    await execFileAsync(process.execPath, [generatorPath, outputPath]);

    const output = await readFile(outputPath, "utf8");
    expect(output).toContain(
      "// GENERATED from @dev.fast/review-protocol. Do not edit.",
    );
    expect(output).toContain("export const ReviewRuntimeConfigSchema");
    expect(output).toContain("export const ReviewRuntimeConfigSchema");
    expect(output).not.toContain("./contracts.js");
    expect(output.match(/from "zod\/v4"/g)).toHaveLength(1);
    expect(output).toContain("z.config({ jitless: true });");
    expect(output.indexOf("z.config({ jitless: true });")).toBeLessThan(
      output.indexOf("export const ReviewRuntimeConfigSchema"),
    );
  });

  it("bundles the emitted browser runtime with the protocol's Zod", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "review-protocol-native-bundle-"),
    );
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "reviewProtocol.ts");
    const outputPath = path.join(directory, "reviewProtocol.mjs");

    await execFileAsync(process.execPath, [generatorPath, sourcePath]);
    await execFileAsync(process.execPath, [
      bundlerPath,
      sourcePath,
      outputPath,
    ]);

    const output = await readFile(outputPath, "utf8");
    expect(output).not.toContain('from "zod');
    const protocol = await import(pathToFileURL(outputPath).href);
    expect(
      protocol.ReviewRangeSchema.parse({
        fromLine: 1,
        toLine: 2,
      }),
    ).toEqual({
      fromLine: 1,
      toLine: 2,
    });
  });
});
