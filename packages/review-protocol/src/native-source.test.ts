import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
    expect(output).not.toContain("./contracts.js");
    expect(output).not.toContain("./bug-report.js");
    expect(output).not.toContain("./json.js");
    expect(output).not.toContain("./runtime-value.js");
    // The inlined dependency modules land whole, exactly once each.
    expect(output.match(/export function isCallableValue\(/g)).toHaveLength(1);
    expect(output.match(/export function parseJsonText\(/g)).toHaveLength(1);
    expect(output.match(/export type JsonValue =/g)).toHaveLength(1);
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

  it("is insensitive to import formatting in the source files", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "review-protocol-native-reformat-"),
    );
    temporaryDirectories.push(directory);
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const sourceRoot = path.join(directory, "src");
    await mkdir(sourceRoot, { recursive: true });
    for (const name of [
      "runtime-value.ts",
      "json.ts",
      "contracts.ts",
      "index.ts",
      "bug-report.ts",
    ]) {
      await copyFile(
        path.join(packageRoot, "src", name),
        path.join(sourceRoot, name),
      );
    }
    // Reformat index.ts: one named import per line, different order, the
    // re-exports moved to the bottom of the file, and the `contracts.js`
    // re-export rewritten from `export * from` to a wrapped multi-line
    // named re-export.
    const indexPath = path.join(sourceRoot, "index.ts");
    const original = await readFile(indexPath, "utf8");
    const reexports = original
      .split("\n")
      .filter((line) => line.startsWith("export * from "))
      .map((line) =>
        line === 'export * from "./contracts.js";'
          ? 'export {\n  sessionIdSchema,\n  commitShaSchema,\n} from "./contracts.js";'
          : line,
      );
    const body = original
      .split("\n")
      .filter((line) => !line.startsWith("export * from "))
      .join("\n");
    const reformatted = body
      .replace(
        /import \{([\s\S]*?)\} from "\.\/contracts\.js";/,
        (_match, names: string) =>
          names
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
            .reverse()
            .map((name) => `import { ${name} } from "./contracts.js";`)
            .join("\n"),
      )
      .concat("\n", reexports.join("\n"), "\n");
    await writeFile(indexPath, reformatted);

    const expectedPath = path.join(directory, "expected.ts");
    const actualPath = path.join(directory, "actual.ts");
    await execFileAsync(process.execPath, [generatorPath, expectedPath]);
    await execFileAsync(process.execPath, [
      generatorPath,
      actualPath,
      "--source-root",
      sourceRoot,
    ]);
    const actual = await readFile(actualPath, "utf8");
    expect(actual).toBe(await readFile(expectedPath, "utf8"));
    expect(actual).not.toContain("./contracts.js");
  });

  it("preserves a local multi-line export list without a from clause", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "review-protocol-native-local-export-"),
    );
    temporaryDirectories.push(directory);
    const sourceRoot = path.join(directory, "src");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "runtime-value.ts"), "");
    await writeFile(path.join(sourceRoot, "json.ts"), "");
    await writeFile(
      path.join(sourceRoot, "contracts.ts"),
      [
        "export const a = 1;",
        "export const b = 2;",
        "export {",
        "  a,",
        "  b,",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(sourceRoot, "index.ts"),
      ['import { z } from "zod";', 'export * from "./contracts.js";', ""].join(
        "\n",
      ),
    );

    const outputPath = path.join(directory, "actual.ts");
    await execFileAsync(process.execPath, [
      generatorPath,
      outputPath,
      "--source-root",
      sourceRoot,
    ]);

    const output = await readFile(outputPath, "utf8");
    expect(output).toContain("export {\n  a,\n  b,\n};");
  });
});
