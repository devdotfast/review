import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  gitCommonDirSync,
  readNote,
  remoteNotesRef,
  writeNote,
} from "@dev.fast/local-vcs";
import { describe, expect, it } from "vitest";

import {
  SOFTWARE_MAP_NOTES_REF,
  materializedSoftwareMapDir,
} from "./review-storage";
import {
  CANONICAL_SOFTWARE_MAP_MODEL_IMPORT,
  canonicalizeModelImport,
  flushScratch,
  hydrateScratch,
  localizeModelImport,
  materializeSoftwareMapAtRef,
  materializeSoftwareMapAtRefSync,
  readSoftwareMapSourceForRef,
  readSoftwareMapSourceForRefSync,
  scratchSoftwareMapPath,
} from "./software-map-artifact";

const MAP_SOURCE = (label: string) =>
  [
    `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
    "",
    `export default defineSoftwareMap({ systems: { app: { label: ${JSON.stringify(label)} } } });`,
    "",
  ].join("\n");

describe("model import rewriting", () => {
  it("canonicalizes relative and package model imports", () => {
    for (const spec of [
      "../packages/progressive-review/src/software-map-model.ts",
      "./software-map-model",
      "/abs/path/to/software-map-model.js",
      CANONICAL_SOFTWARE_MAP_MODEL_IMPORT,
    ]) {
      const source = `import { defineSoftwareMap } from "${spec}";\nexport default defineSoftwareMap({});\n`;
      expect(canonicalizeModelImport(source)).toContain(
        `from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}"`,
      );
    }
  });

  it("localizes the canonical import to a real module path", () => {
    const localized = localizeModelImport({
      source: MAP_SOURCE("X"),
      outputPath: "/tmp/somewhere/deep/software-map.ts",
    });
    expect(localized).not.toContain(CANONICAL_SOFTWARE_MAP_MODEL_IMPORT);
    expect(localized).toMatch(/from "(file:\/\/|\.\.?\/)/);
    expect(localized).toContain("tolerant-software-map-model");
  });

  it("emits $-patterns in localized import paths literally", () => {
    // `$&`/`$1` are special in String.replace replacement strings; a path
    // containing them must land in the emitted import verbatim.
    const localized = localizeModelImport({
      source: MAP_SOURCE("Dollar"),
      outputPath: "/tmp/somewhere/software-map.ts",
      packageRoot: "/tmp/pkgs/$&-weird/$1",
    });
    expect(localized).toContain("$&-weird/$1/");
    expect(localized).not.toContain(CANONICAL_SOFTWARE_MAP_MODEL_IMPORT);
  });

  it("round-trips canonicalize after localize", () => {
    const localized = localizeModelImport({
      source: MAP_SOURCE("Y"),
      outputPath: "/tmp/x/software-map.ts",
    });
    expect(canonicalizeModelImport(localized)).toContain(
      `from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}"`,
    );
  });

  it("leaves unrelated imports alone when rewriting map imports", () => {
    const source = [
      `import path from "node:path";`,
      `import { defineSoftwareMap } from "./software-map-model";`,
    ].join("\n");
    const rewritten = canonicalizeModelImport(source);
    expect(rewritten).toContain(`from "node:path"`);
    expect(rewritten).toContain(
      `from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}"`,
    );
  });
});

describe("the read ladder", () => {
  it("tier 1: reads the local note for a resolved commit (both roles)", async () => {
    const repo = await gitFixture("map-ladder-note-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: MAP_SOURCE("Note"),
      });
      for (const role of ["head", "base"] as const) {
        const read = await readSoftwareMapSourceForRef({
          repoRootPath: repo,
          ref: "HEAD",
          role,
        });
        expect(read).toMatchObject({ commit, tier: "note" });
        expect(read?.source).toContain("Note");
      }
      const syncRead = readSoftwareMapSourceForRefSync({
        repoRootPath: repo,
        ref: "HEAD",
        role: "base",
      });
      expect(syncRead).toMatchObject({ commit, tier: "note" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("tier 2: falls back to a fetched peer note and backfills the local ref", async () => {
    const repo = await gitFixture("map-ladder-remote-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
        commit,
        content: MAP_SOURCE("Peer"),
      });
      const read = await readSoftwareMapSourceForRef({
        repoRootPath: repo,
        ref: "HEAD",
        role: "base",
      });
      expect(read).toMatchObject({ commit, tier: "remote-note" });
      // Backfill: the local ref now serves tier 1.
      expect(
        await readNote({
          rootPath: repo,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit,
        }),
      ).toContain("Peer");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("misses strictly for both roles when no note exists — no file fallback", async () => {
    const repo = await gitFixture("map-ladder-strict-");
    try {
      // Even a hydrated (stub) scratch for HEAD must not serve reads: the
      // ladder ends at notes.
      await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      for (const role of ["head", "base"] as const) {
        expect(
          await readSoftwareMapSourceForRef({
            repoRootPath: repo,
            ref: "HEAD",
            role,
          }),
        ).toBeNull();
        expect(
          readSoftwareMapSourceForRefSync({
            repoRootPath: repo,
            ref: "HEAD",
            role,
          }),
        ).toBeNull();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("misses entirely outside a git repository", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "map-ladder-nogit-"));
    try {
      expect(
        await readSoftwareMapSourceForRef({
          repoRootPath: dir,
          ref: "HEAD",
          role: "head",
        }),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!commandExists("jj"))(
    "tier 3: recovers a note across a jj rewrite via the evolog and backfills",
    async () => {
      const repo = await jjFixture("map-ladder-evolog-");
      try {
        jj(repo, ["describe", "-m", "original"]);
        const original = jjHead(repo);
        await writeNote({
          rootPath: repo,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit: original,
          content: MAP_SOURCE("Evolog"),
        });
        jj(repo, ["describe", "-m", "rewritten"]);
        const rewritten = jjHead(repo);
        expect(rewritten).not.toBe(original);

        const read = await readSoftwareMapSourceForRef({
          repoRootPath: repo,
          ref: rewritten,
          role: "base",
        });
        expect(read).toMatchObject({ commit: rewritten, tier: "evolog" });
        expect(read?.source).toContain("Evolog");

        // Copied forward: the rewritten commit now has its own note.
        const second = await readSoftwareMapSourceForRef({
          repoRootPath: repo,
          ref: rewritten,
          role: "base",
        });
        expect(second).toMatchObject({ tier: "note" });
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    },
  );
});

describe("scratch hydration", () => {
  it("hydrates a scratch from the local note, byte-equal and note-shaped", async () => {
    const repo = await gitFixture("scratch-hydrate-note-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: MAP_SOURCE("Hydrated"),
      });
      const hydrated = await hydrateScratch({
        repoRootPath: repo,
        rev: "HEAD",
      });
      expect(hydrated).toMatchObject({
        commit,
        hydratedFrom: "note",
        dirty: false,
      });
      expect(hydrated.path).toBe(
        scratchSoftwareMapPath({ repoRootPath: repo, commit }),
      );
      // Byte-equal to the note, canonical import kept canonical.
      expect(await readFile(hydrated.path, "utf8")).toBe(
        MAP_SOURCE("Hydrated"),
      );
      // Editor DX lands beside the scratch.
      const scratchDir = path.dirname(hydrated.path);
      expect(existsSync(path.join(scratchDir, "software-map-model.d.ts"))).toBe(
        true,
      );
      expect(existsSync(path.join(scratchDir, "tsconfig.json"))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("hydrates from a fetched peer note", async () => {
    const repo = await gitFixture("scratch-hydrate-remote-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
        commit,
        content: MAP_SOURCE("Peer"),
      });
      const hydrated = await hydrateScratch({
        repoRootPath: repo,
        rev: "HEAD",
      });
      expect(hydrated).toMatchObject({
        commit,
        hydratedFrom: "remote-note",
        dirty: false,
      });
      expect(await readFile(hydrated.path, "utf8")).toBe(MAP_SOURCE("Peer"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("seeds from the NEAREST annotated first-parent ancestor, with distance", async () => {
    const repo = await gitFixture("scratch-hydrate-ancestor-");
    try {
      const far = head(repo);
      await commitFile(repo, "near.txt", "near");
      const near = head(repo);
      await commitFile(repo, "tip.txt", "tip");
      await commitFile(repo, "tip2.txt", "tip2");
      const tip = head(repo);

      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: far,
        content: MAP_SOURCE("Far"),
      });
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: near,
        content: MAP_SOURCE("Near"),
      });

      const hydrated = await hydrateScratch({ repoRootPath: repo, rev: tip });
      expect(hydrated).toMatchObject({
        commit: tip,
        hydratedFrom: "ancestor-note",
        seedCommit: near,
        distance: 2,
        dirty: false,
      });
      expect(await readFile(hydrated.path, "utf8")).toBe(MAP_SOURCE("Near"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("finds ancestor seeds in the fetched remote namespace too", async () => {
    const repo = await gitFixture("scratch-hydrate-ancestor-remote-");
    try {
      const base = head(repo);
      await commitFile(repo, "tip.txt", "tip");
      const tip = head(repo);
      await writeNote({
        rootPath: repo,
        ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
        commit: base,
        content: MAP_SOURCE("Remote ancestor"),
      });

      const hydrated = await hydrateScratch({ repoRootPath: repo, rev: tip });
      expect(hydrated).toMatchObject({
        hydratedFrom: "ancestor-note",
        seedCommit: base,
        distance: 1,
      });
      expect(await readFile(hydrated.path, "utf8")).toBe(
        MAP_SOURCE("Remote ancestor"),
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("prefers the exact commit's note over any ancestor's", async () => {
    const repo = await gitFixture("scratch-hydrate-exact-over-ancestor-");
    try {
      const base = head(repo);
      await commitFile(repo, "tip.txt", "tip");
      const tip = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: base,
        content: MAP_SOURCE("Ancestor"),
      });
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: tip,
        content: MAP_SOURCE("Exact"),
      });

      const hydrated = await hydrateScratch({ repoRootPath: repo, rev: tip });
      expect(hydrated).toMatchObject({ hydratedFrom: "note", dirty: false });
      expect(hydrated.seedCommit).toBeUndefined();
      expect(await readFile(hydrated.path, "utf8")).toBe(MAP_SOURCE("Exact"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("writes the schema stub when the ladder fully misses", async () => {
    const repo = await gitFixture("scratch-hydrate-stub-");
    try {
      const commit = head(repo);
      const hydrated = await hydrateScratch({
        repoRootPath: repo,
        rev: "HEAD",
      });
      expect(hydrated).toMatchObject({
        commit,
        hydratedFrom: "stub",
        dirty: false,
      });
      const stub = await readFile(hydrated.path, "utf8");
      expect(stub).toContain(CANONICAL_SOFTWARE_MAP_MODEL_IMPORT);
      expect(stub).toContain("defineSoftwareMap({");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("leaves a dirty scratch alone, and discards it with force", async () => {
    const repo = await gitFixture("scratch-hydrate-dirty-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: MAP_SOURCE("Original"),
      });
      const first = await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      await writeFile(first.path, MAP_SOURCE("Edited"), "utf8");

      const second = await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      expect(second.dirty).toBe(true);
      // Unflushed edits survive.
      expect(await readFile(first.path, "utf8")).toBe(MAP_SOURCE("Edited"));

      const forced = await hydrateScratch({
        repoRootPath: repo,
        rev: "HEAD",
        force: true,
      });
      expect(forced.dirty).toBe(false);
      expect(await readFile(first.path, "utf8")).toBe(MAP_SOURCE("Original"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("re-hydrates silently when the scratch is byte-equal to the note", async () => {
    const repo = await gitFixture("scratch-hydrate-equal-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: MAP_SOURCE("Same"),
      });
      await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      const again = await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      expect(again).toMatchObject({
        commit,
        dirty: false,
        hydratedFrom: "note",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("throws on unresolvable revisions", async () => {
    const repo = await gitFixture("scratch-hydrate-badrev-");
    try {
      await expect(
        hydrateScratch({ repoRootPath: repo, rev: "not-a-rev" }),
      ).rejects.toThrow("Unable to resolve revision");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("does not read an untouched stub scratch as dirty on re-open", async () => {
    const repo = await gitFixture("scratch-hydrate-stub-clean-");
    try {
      // No note anywhere: hydration writes the schema stub.
      const first = await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      expect(first.hydratedFrom).toBe("stub");
      // Re-open without force: the stub matches what hydration would write,
      // so it is NOT dirty (the old null-compare flagged every stub dirty).
      const second = await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      expect(second).toMatchObject({ hydratedFrom: "stub", dirty: false });
      // An edited stub IS dirty.
      await writeFile(first.path, MAP_SOURCE("Edited stub"), "utf8");
      const third = await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      expect(third.dirty).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("scratch flush", () => {
  it("round-trips the scratch to the note byte-exactly", async () => {
    const repo = await gitFixture("scratch-flush-");
    try {
      const commit = head(repo);
      const hydrated = await hydrateScratch({
        repoRootPath: repo,
        rev: "HEAD",
      });
      await writeFile(hydrated.path, MAP_SOURCE("Flushed"), "utf8");

      const flushed = await flushScratch({ repoRootPath: repo, commit });
      expect(flushed).toEqual({ commit });
      expect(
        await readNote({ rootPath: repo, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toBe(MAP_SOURCE("Flushed"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses to flush when no scratch exists", async () => {
    const repo = await gitFixture("scratch-flush-missing-");
    try {
      await expect(
        flushScratch({ repoRootPath: repo, commit: head(repo) }),
      ).rejects.toThrow("No scratch exists");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("canonicalizes the model import before writing the note", async () => {
    const repo = await gitFixture("scratch-flush-canonical-");
    try {
      const commit = head(repo);
      await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: repo,
        commit,
      })!;
      // A localized (relative) import in the scratch must not leak into the
      // stored note: notes are location-independent, and the prune sweep's
      // equality check compares canonicalized content to the note.
      const localized = [
        'import { defineSoftwareMap } from "../../some/where/software-map-model.ts";',
        'export default defineSoftwareMap({ systems: { app: { label: "L" } } });',
        "",
      ].join("\n");
      await writeFile(scratchPath, localized, "utf8");

      await flushScratch({ repoRootPath: repo, commit });
      const note = await readNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
      });
      expect(note).toContain(`from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}"`);
      expect(note).not.toContain("some/where");
      expect(note).toBe(canonicalizeModelImport(localized));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("publishes exactly the threaded validated bytes, not a scratch re-read", async () => {
    const repo = await gitFixture("scratch-flush-threaded-");
    try {
      const commit = head(repo);
      await hydrateScratch({ repoRootPath: repo, rev: "HEAD" });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: repo,
        commit,
      })!;
      const validated = MAP_SOURCE("Validated bytes");
      // The scratch mutates AFTER validation (simulating a concurrent edit);
      // the flush must still publish the validated bytes.
      await writeFile(
        scratchPath,
        MAP_SOURCE("Mutated after validation"),
        "utf8",
      );
      await flushScratch({
        repoRootPath: repo,
        commit,
        mapSource: validated,
      });
      expect(
        await readNote({ rootPath: repo, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toBe(validated);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("materialization", () => {
  it("writes the note into the git-dir cache with a localized import", async () => {
    const repo = await gitFixture("map-materialize-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: MAP_SOURCE("Materialized"),
      });
      const artifactPath = await materializeSoftwareMapAtRef({
        repoRootPath: repo,
        ref: "HEAD",
        role: "base",
      });
      const gitDir = gitCommonDirSync(repo)!;
      expect(artifactPath).toBe(
        path.join(
          materializedSoftwareMapDir(gitDir, commit),
          "software-map.ts",
        ),
      );
      const artifact = await readFile(artifactPath!, "utf8");
      expect(artifact).toContain("Materialized");
      expect(artifact).not.toContain(CANONICAL_SOFTWARE_MAP_MODEL_IMPORT);
      expect(artifact).toContain("tolerant-software-map-model");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("is write-if-changed: re-materializing does not rewrite the file", async () => {
    const repo = await gitFixture("map-materialize-stable-");
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: MAP_SOURCE("Stable"),
      });
      const first = materializeSoftwareMapAtRefSync({
        repoRootPath: repo,
        ref: "HEAD",
        role: "base",
      });
      const before = statSync(first!).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = materializeSoftwareMapAtRefSync({
        repoRootPath: repo,
        ref: "HEAD",
        role: "base",
      });
      expect(second).toBe(first);
      expect(statSync(first!).mtimeMs).toBe(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("returns null when nothing can serve the ref", async () => {
    const repo = await gitFixture("map-materialize-miss-");
    try {
      expect(
        await materializeSoftwareMapAtRef({
          repoRootPath: repo,
          ref: "HEAD",
          role: "base",
        }),
      ).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns (but still materializes) when a note fails strict validation", async () => {
    const repo = await gitFixture("map-materialize-invalid-");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const commit = head(repo);
      await writeNote({
        rootPath: repo,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: [
          `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
          // `views` inside the model is rejected by the strict schema; the
          // tolerant model renders it anyway. This is the schema-drift case.
          "export default defineSoftwareMap({ views: {} });",
        ].join("\n"),
      });
      const artifactPath = await materializeSoftwareMapAtRef({
        repoRootPath: repo,
        ref: "HEAD",
        role: "head",
      });
      expect(artifactPath).not.toBeNull();
      expect(warnings.join("\n")).toContain(commit);
      expect(warnings.join("\n")).toContain("failed strict validation");
    } finally {
      console.warn = originalWarn;
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function gitFixture(prefix: string): Promise<string> {
  const raw = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = await realpath(raw);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  await writeFile(path.join(repo, "README.md"), "base\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

async function commitFile(
  repo: string,
  fileName: string,
  contents: string,
): Promise<void> {
  await writeFile(path.join(repo, fileName), `${contents}\n`, "utf8");
  git(repo, ["add", fileName]);
  git(repo, ["commit", "-q", "-m", contents]);
}

async function jjFixture(prefix: string): Promise<string> {
  const raw = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = await realpath(raw);
  jj(repo, ["git", "init", "--colocate"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  return repo;
}

function head(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function jjHead(repo: string): string {
  return execFileSync(
    "jj",
    ["log", "-r", "@", "--no-graph", "-T", "commit_id"],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function jj(cwd: string, args: string[]): void {
  execFileSync("jj", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
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
