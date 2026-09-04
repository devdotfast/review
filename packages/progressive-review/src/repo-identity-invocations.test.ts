import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = [path.resolve(import.meta.dirname)];

const ALLOWLIST: ReadonlyArray<{
  location: string;
  justification: string;
}> = [
  {
    location: "src/software-map-health.ts:258",
    justification:
      "readCommitTreeFileSync builds its args with gitArgsSync one statement earlier so the same array can name the traceCommandSync span.",
  },
];

describe("repo identity subprocesses", () => {
  it("pins every production git and gh invocation to an explicit repository", () => {
    const violations: string[] = [];

    for (const filePath of SOURCE_ROOTS.flatMap(typescriptSources)) {
      const source = readFileSync(filePath, "utf8");
      const commandPattern =
        /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'](git|gh)(?=["'\s])/g;
      for (const match of source.matchAll(commandPattern)) {
        const command = match[1];
        const start = match.index;
        const invocation = readCall(source, start);
        const line = source.slice(0, start).split("\n").length;
        const location = `${path.relative(process.cwd(), filePath)}:${line}`;
        const explicitlyScoped =
          command === "gh"
            ? /["']-R["']|\s-R\s/.test(invocation)
            : /["']--git-dir["']|\s--git-dir(?:=|\s)|["']-C["']|\s-C\s|gitArgsSync\s*\(/.test(
                invocation,
              );
        if (
          !explicitlyScoped &&
          !ALLOWLIST.some((entry) => entry.location === location)
        ) {
          violations.push(`${location} ${command}: ${firstLine(invocation)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function typescriptSources(rootPath: string): string[] {
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) return typescriptSources(entryPath);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return [entryPath];
  });
}

function readCall(source: string, matchStart: number): string {
  const openParen = source.indexOf("(", matchStart);
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = openParen; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(matchStart, index + 1);
    }
  }
  return source.slice(matchStart);
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}
