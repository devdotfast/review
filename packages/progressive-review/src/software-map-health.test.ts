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
      expect(errors).toEqual([
        'SoftwareMap coverage: "product.web.shell" range 1-10 exceeds "./src/app.ts" length (4 lines).',
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

describe("checkSoftwareMapSource submodule gitlink directory claim", () => {
  // `git ls-tree -r` lists a submodule as a mode-`160000` gitlink DIRECTORY
  // entry (e.g. `vendor/lib`), but the referenced commit object lives only in
  // the submodule's own object database — never the parent's — so
  // `git cat-file --batch` on `<commit>:<submodule-dir>` emits a `missing`
  // record. The eager pre-fetch in `checkSoftwareMapSource` parsed that as a
  // numeric size and threw `Invalid git object header`, escaping the
  // structured-error contract. `listCommitTreeFiles` now skips gitlink
  // entries, so the directory fails the `treeFiles.includes()` membership
  // check and the structured coverage validator reports the clean "missing
  // from tree" diagnostic instead of throwing.
  it("returns a structured 'missing from tree' error (not a throw) for a real submodule directory", async () => {
    if (!commandExists("git")) return;
    const fixture = await gitFixtureWithSubmodule("map-health-submodule-");
    try {
      let threw: Error | null = null;
      let errors: string[] | null = null;
      try {
        errors = await runCheck(fixture, {
          path: "vendor/lib",
          ranges: [{ fromLine: 1, toLine: 2 }],
        });
      } catch (error) {
        threw = error instanceof Error ? error : new Error(String(error));
      }
      expect(threw).toBeNull();
      expect(errors).toEqual([
        `SoftwareMap coverage: "product.web.shell" claims file "vendor/lib" missing from tree of ${fixture.commit.slice(0, 12)}.`,
      ]);
    } finally {
      await rm(fixture.rootPath, { recursive: true, force: true });
      await rm(fixture.subRootPath, { recursive: true, force: true });
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

// A genuine `git submodule add` fixture (not a fake-SHA gitlink): the
// submodule is fully cloned into the parent worktree, yet its commit object
// still lives only in `vendor/lib/.git`, never the parent's object database —
// which is exactly the condition `git cat-file --batch` reports as `missing`.
async function gitFixtureWithSubmodule(
  prefix: string,
): Promise<{ rootPath: string; commit: string; subRootPath: string }> {
  const rawRootPath = await mkdtemp(path.join(tmpdir(), prefix));
  const rootPath = await realpath(rawRootPath);
  const rawSubRootPath = await mkdtemp(path.join(tmpdir(), `${prefix}sub-`));
  const subRootPath = await realpath(rawSubRootPath);
  // Submodule repo with one commit.
  execGit(subRootPath, ["init", "-b", "main"]);
  execGit(subRootPath, ["config", "user.email", "review@example.com"]);
  execGit(subRootPath, ["config", "user.name", "Review Test"]);
  writeFileSync(path.join(subRootPath, "readme.md"), "sub\n");
  execGit(subRootPath, ["add", "."]);
  execGit(subRootPath, ["commit", "-m", "sub init"]);
  // Parent repo: own file plus the real submodule, one commit.
  execGit(rootPath, ["init", "-b", "main"]);
  execGit(rootPath, ["config", "user.email", "review@example.com"]);
  execGit(rootPath, ["config", "user.name", "Review Test"]);
  mkdirSync(path.join(rootPath, "src"), { recursive: true });
  writeFileSync(
    path.join(rootPath, "src", "app.ts"),
    "line 1\nline 2\nline 3\n",
  );
  execGit(rootPath, ["add", "src/app.ts"]);
  execGit(rootPath, ["commit", "-m", "pre"]);
  // `git submodule add` of a local upstream spawns an inner `git clone` that
  // does not inherit the repo's `protocol.file.allow` setting under CVE
  // hardening (git >= 2.38), so the override must be passed inline via `-c`.
  execGit(rootPath, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    subRootPath,
    "vendor/lib",
  ]);
  execGit(rootPath, ["commit", "-m", "add submodule"]);
  const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
  return { rootPath, commit, subRootPath };
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
