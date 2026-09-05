import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CANONICAL_SOFTWARE_MAP_MODEL_IMPORT } from "./software-map-artifact";
import { checkSoftwareMapSource } from "./software-map-health";

describe("checkSoftwareMapSource coverage path normalization", () => {
  // The pre-fetch in checkSoftwareMapSource keyed its bulk-read file map by
  // the raw authored path while the validator looks up by the normalized
  // form; non-canonical claims with ranges were dropped from the pre-fetch
  // against the canonical `git ls-tree` set, surfacing as a spurious
  // `claims unreadable file` error for a file that is present and readable.
  it("accepts a ./-prefixed coverage file with ranges against the commit tree", async () => {
    if (!commandExists("git")) return;
    const fixture = await gitFixtureWithApp("map-health-dotprefix-");
    try {
      const errors = await runCheck(fixture, {
        path: "./src/app.ts",
        ranges: [{ fromLine: 1, toLine: 2 }],
      });
      expect(errors).toEqual([]);
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  it("accepts a backslash-separated coverage file with ranges against the commit tree", async () => {
    if (!commandExists("git")) return;
    const fixture = await gitFixtureWithApp("map-health-backslash-");
    try {
      const errors = await runCheck(fixture, {
        path: "src\\app.ts",
        ranges: [{ fromLine: 1, toLine: 2 }],
      });
      expect(errors).toEqual([]);
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  // Range-validating (rather than reporting `unreadable`) proves the file was
  // actually prefetched and read, so the non-canonical claim is treated
  // exactly like its canonical form.
  it("range-validates a ./-prefixed coverage file instead of reporting it unreadable", async () => {
    if (!commandExists("git")) return;
    const fixture = await gitFixtureWithApp("map-health-range-");
    try {
      const errors = await runCheck(fixture, {
        path: "./src/app.ts",
        ranges: [{ fromLine: 1, toLine: 10 }],
      });
      // The fixture's "line 1\nline 2\nline 3\n" is a newline-terminated file
      // with 3 content lines, so the reported length is the true count (not
      // the trailing-newline-inflated count the validator used to emit).
      expect(errors).toEqual([
        'SoftwareMap coverage: "product.web.shell" range 1-10 exceeds "./src/app.ts" length (3 lines).',
      ]);
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  // A genuinely-absent non-canonical claim must still be reported as missing
  // (the validator normalizes for the tracked-set check); the fix must not
  // silence that or flip it to the misleading `unreadable` framing.
  it("reports a ./-prefixed coverage file as missing when absent from the commit tree", async () => {
    if (!commandExists("git")) return;
    const fixture = await gitFixtureWithApp("map-health-missing-");
    try {
      const errors = await runCheck(fixture, {
        path: "./src/missing.ts",
        ranges: [{ fromLine: 1, toLine: 2 }],
      });
      expect(errors).toEqual([
        `SoftwareMap coverage: "product.web.shell" claims file "./src/missing.ts" missing from tree of ${fixture.commit.slice(0, 12)}.`,
      ]);
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  it("accepts a canonical coverage file with ranges against the commit tree (no regression)", async () => {
    if (!commandExists("git")) return;
    const fixture = await gitFixtureWithApp("map-health-canonical-");
    try {
      const errors = await runCheck(fixture, {
        path: "src/app.ts",
        ranges: [{ fromLine: 1, toLine: 2 }],
      });
      expect(errors).toEqual([]);
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
    }
  });
});

async function runCheck(
  fixture: { rootPath: string; commit: string },
  coverageFile: {
    path: string;
    ranges: Array<{ fromLine: number; toLine: number }>;
  },
): Promise<string[]> {
  const { errors } = await checkSoftwareMapSource({
    repoRootPath: fixture.rootPath,
    commit: fixture.commit,
    source: authoredMapSource(coverageFile),
    sourceName: "software-map.ts",
  });
  return errors;
}

function authoredMapSource(coverageFile: {
  path: string;
  ranges: Array<{ fromLine: number; toLine: number }>;
}): string {
  const files = JSON.stringify([coverageFile]);
  return [
    `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
    "",
    "export default defineSoftwareMap({",
    "  systems: {",
    "    product: {",
    "      containers: {",
    "        web: {",
    `          components: { shell: { coverage: { files: ${files} } } },`,
    "        },",
    "      },",
    "    },",
    "  },",
    "});",
    "",
  ].join("\n");
}

async function gitFixtureWithApp(
  prefix: string,
): Promise<{ rootPath: string; commit: string }> {
  const rawRootPath = await mkdtemp(path.join(tmpdir(), prefix));
  const rootPath = await realpath(rawRootPath);
  execGit(rootPath, ["init", "-b", "main"]);
  execGit(rootPath, ["config", "user.email", "review@example.com"]);
  execGit(rootPath, ["config", "user.name", "Review Test"]);
  mkdirSync(path.join(rootPath, "src"), { recursive: true });
  writeFileSync(
    path.join(rootPath, "src", "app.ts"),
    "line 1\nline 2\nline 3\n",
  );
  execGit(rootPath, ["add", "src/app.ts"]);
  execGit(rootPath, ["commit", "-m", "base"]);
  const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
  return { rootPath, commit };
}

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function execGit(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function execGitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
