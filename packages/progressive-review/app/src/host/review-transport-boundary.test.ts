import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appSourceRoot = fileURLToPath(new URL("../", import.meta.url));
const transportModule = fileURLToPath(
  new URL("./review-client.ts", import.meta.url),
);

describe("review host transport boundary", () => {
  it("keeps the private API prefix and raw transport constructors in one module", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(appSourceRoot)) {
      if (
        file === transportModule ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      ) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (source.includes("__progressive-review")) {
        violations.push(`${file}: private API prefix`);
      }
      if (/(?<![.\w])fetch\s*\(/.test(source)) {
        violations.push(`${file}: raw fetch`);
      }
      if (/new\s+EventSource\s*\(/.test(source)) {
        violations.push(`${file}: raw EventSource`);
      }
    }
    expect(violations).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}
