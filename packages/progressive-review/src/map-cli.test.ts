import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  listNoteCommits,
  readNote,
  remoteNotesRef,
  writeNote,
} from "@dev.fast/local-vcs";
import { describe, expect, it } from "vitest";

import { collectingWritable } from "./cli-output";
import { parseSoftwareMapCliArgs, runSoftwareMapCli } from "./map-cli";
import { createReviewDir } from "./review-home";
import { SOFTWARE_MAP_NOTES_REF } from "./review-storage";
import {
  CANONICAL_SOFTWARE_MAP_MODEL_IMPORT,
  scratchSoftwareMapPath,
} from "./software-map-artifact";

describe("parseSoftwareMapCliArgs", () => {
  it("accepts a Review UUID on check", () => {
    expect(
      parseSoftwareMapCliArgs(["check", "HEAD", "--review", "uuid-1"]),
    ).toMatchObject({
      ok: true,
      command: "check",
      positionals: ["HEAD"],
      review: "uuid-1",
    });
  });

  it("defaults to check without a revision", () => {
    expect(parseSoftwareMapCliArgs([])).toEqual({
      ok: true,
      command: "check",
      positionals: [],
      force: false,
      diffRefs: {},
      json: false,
    });
  });

  it.each([
    [["open", "HEAD"], "open", ["HEAD"]],
    [["check"], "check", []],
    [["check", "main"], "check", ["main"]],
    [["prune"], "prune", []],
    [["push"], "push", []],
    [["fetch"], "fetch", []],
  ] as const)("parses %j", (args, command, positionals) => {
    expect(parseSoftwareMapCliArgs(args)).toMatchObject({
      ok: true,
      command,
      positionals,
    });
  });

  it("parses --force before or after open's revision", () => {
    for (const args of [
      ["open", "--force", "HEAD"],
      ["open", "HEAD", "--force"],
    ]) {
      expect(parseSoftwareMapCliArgs(args)).toEqual({
        ok: true,
        command: "open",
        positionals: ["HEAD"],
        force: true,
        diffRefs: {},
        json: false,
      });
    }
  });

  it("parses map publication options", () => {
    expect(
      parseSoftwareMapCliArgs([
        "publish",
        "--review",
        "3b241101-e2bb-4255-8caf-4136c566a962",
        "--json",
      ]),
    ).toMatchObject({
      ok: true,
      command: "publish",
      review: "3b241101-e2bb-4255-8caf-4136c566a962",
      json: true,
    });
  });

  it("parses an explicit notes remote for push and fetch", () => {
    expect(parseSoftwareMapCliArgs(["push", "--remote", "fork"])).toMatchObject(
      {
        ok: true,
        command: "push",
        remote: "fork",
      },
    );
    expect(parseSoftwareMapCliArgs(["fetch", "--remote=fork"])).toMatchObject({
      ok: true,
      command: "fetch",
      remote: "fork",
    });
  });

  it("hard-errors on unknown flags instead of silently ignoring them", () => {
    expect(parseSoftwareMapCliArgs(["open", "HEAD", "--froce"])).toEqual({
      ok: false,
      error: "Unknown flag: --froce",
    });
    expect(parseSoftwareMapCliArgs(["check", "--quiet"])).toEqual({
      ok: false,
      error: "Unknown flag: --quiet",
    });
  });

  it("rejects the removed update-style flags with a pointer to positionals", () => {
    for (const args of [
      ["check", "--base", "main"],
      ["update", "--head=feature", "--base", "main"],
      ["update", "--pr", "175"],
    ]) {
      expect(parseSoftwareMapCliArgs(args)).toMatchObject({
        ok: false,
        error: expect.stringContaining("removed review map update"),
      });
    }
  });

  it.each(["base", "head", "pr"])("reports a missing --%s value", (option) => {
    expect(parseSoftwareMapCliArgs(["check", `--${option}`])).toEqual({
      ok: false,
      error: `Expected a value after --${option}.`,
    });
    expect(parseSoftwareMapCliArgs(["check", `--${option}=`])).toEqual({
      ok: false,
      error: `Expected a value after --${option}.`,
    });
  });

  it("reports a missing --remote value", () => {
    expect(parseSoftwareMapCliArgs(["push", "--remote"])).toEqual({
      ok: false,
      error: "Expected a value after --remote.",
    });
  });

  it("reports open's missing revision", () => {
    expect(parseSoftwareMapCliArgs(["open"])).toEqual({
      ok: false,
      error: "Expected a revision after open.",
    });
  });
});

describe("removed commands point at their replacements", () => {
  it.each(["snapshot", "refresh"])(
    "review map %s points at check's flush-on-green",
    async (command) => {
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: [command],
        cwd: "/repo",
        stdout: writable([]),
        stderr: writable(stderr),
      });
      expect(exitCode).toBe(1);
      expect(stderr.join("")).toContain(`review map ${command} was removed`);
      expect(stderr.join("")).toContain("flushes the scratch");
    },
  );

  it("review map scaffold points at open", async () => {
    const stderr: string[] = [];
    const exitCode = await runSoftwareMapCli({
      args: ["scaffold"],
      cwd: "/repo",
      stdout: writable([]),
      stderr: writable(stderr),
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("review map scaffold was removed");
    expect(stderr.join("")).toContain("review map open <rev>");
  });

  it.each(["init", "update"])(
    "rejects review map %s with guidance",
    async (command) => {
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: [command],
        cwd: "/repo",
        stdout: writable([]),
        stderr: writable(stderr),
      });
      expect(exitCode).toBe(1);
      expect(stderr.join("")).toContain(`review map ${command} was removed`);
      expect(stderr.join("")).toContain("review map open");
      expect(stderr.join("")).toContain("dev-review-map skill");
    },
  );
});

describe("unknown flag handling", () => {
  it("exits 1 and names the flag (a --froce typo must not proceed)", async () => {
    const stderr: string[] = [];
    const exitCode = await runSoftwareMapCli({
      args: ["open", "HEAD", "--froce"],
      cwd: "/repo",
      stdout: writable([]),
      stderr: writable(stderr),
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("Unknown flag: --froce");
  });
});

describe("software map CLI help", () => {
  it.each([
    ["help"],
    ["--help"],
    ["-h"],
    ["open", "--help"],
    ["open", "HEAD", "--help"],
    ["open", "--help", "HEAD"],
    ["check", "-h"],
    ["publish", "--help"],
    ["prune", "--help"],
    ["push", "--help"],
    ["fetch", "--help"],
  ])("describes the scratch model for %j", async (...args) => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSoftwareMapCli({
      args,
      cwd: "/repo",
      stdout: writable(stdout),
      stderr: writable(stderr),
    });

    expect(exitCode).toBe(0);
    const help = stdout.join("");
    expect(help).toContain("review map open <rev>");
    expect(help).toContain("review map check [<rev>]");
    expect(help).toContain("review map publish");
    expect(help).toContain("review map prune");
    expect(help).toContain("review map push");
    expect(help).toContain("refs/notes/dev-fast/*");
    expect(help).toContain("scratch buffer");
    expect(help).toContain("nearest annotated first-parent ancestor");
    expect(help).toContain("SAVES");
    expect(help).not.toContain("carry");
    expect(stderr.join("")).toBe("");
  });
});

describe("review map open", () => {
  it("hydrates a stub scratch and reports provenance", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-open-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      const stdout: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });
      expect(exitCode).toBe(0);
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      })!;
      expect(stdout.join("")).toContain(`scratch: ${scratchPath}`);
      expect(stdout.join("")).toContain(
        "no note found on HEAD or any ancestor; scratch is a schema stub — author a full map",
      );
      const stub = await readFile(scratchPath, "utf8");
      expect(stub).toContain(CANONICAL_SOFTWARE_MAP_MODEL_IMPORT);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("hydrates from an existing note and protects dirty scratches", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-open-note-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: authoredMapSource("Note map"),
      });
      const openStdout: string[] = [];
      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable(openStdout),
        stderr: writable([]),
      });
      expect(openStdout.join("")).toContain(
        `hydrated from the note on ${commit.slice(0, 12)} (this commit); the map is current — verify and check to confirm`,
      );
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      })!;
      expect(await readFile(scratchPath, "utf8")).toBe(
        authoredMapSource("Note map"),
      );

      // Dirty the scratch; open must leave it alone and say so.
      await writeFile(scratchPath, authoredMapSource("Edited"), "utf8");
      const stdout: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });
      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("unflushed edits");
      expect(await readFile(scratchPath, "utf8")).toBe(
        authoredMapSource("Edited"),
      );

      // --force discards the edits and re-hydrates from the note.
      await runSoftwareMapCli({
        args: ["open", "HEAD", "--force"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      expect(await readFile(scratchPath, "utf8")).toBe(
        authoredMapSource("Note map"),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("requires a revision and a git repository", async () => {
    const stderr: string[] = [];
    expect(
      await runSoftwareMapCli({
        args: ["open"],
        cwd: "/repo",
        stdout: writable([]),
        stderr: writable(stderr),
      }),
    ).toBe(1);
    expect(stderr.join("")).toContain("Usage: review map open <rev>");

    const dir = await mkdtemp(path.join(os.tmpdir(), "review-map-open-nogit-"));
    try {
      const nogitStderr: string[] = [];
      expect(
        await runSoftwareMapCli({
          args: ["open", "HEAD"],
          cwd: dir,
          stdout: writable([]),
          stderr: writable(nogitStderr),
        }),
      ).toBe(1);
      expect(nogitStderr.join("")).toContain("not inside a git repository");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("review map check", () => {
  it("preflights the Git identity required to write the map note", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-identity-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      })!;
      await writeFile(
        scratchPath,
        [
          `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
          "",
          "export default defineSoftwareMap({",
          "  systems: {",
          '    app: { label: "App", containers: { core: { label: "Core", components: { readme: { label: "Readme", coverage: { files: ["README.md"] } } } } } },',
          "  },",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      execGit(rootPath, ["config", "user.name", ""]);
      execGit(rootPath, ["config", "user.email", ""]);

      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["check", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable(stderr),
      });

      expect(exitCode).toBe(1);
      expect(stderr.join("")).toMatch(
        /Git author identity.*git config user\.name.*git config user\.email/s,
      );
      expect(stderr.join("")).not.toContain("software map flush failed");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("validates the scratch and flushes it to the note on success", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      })!;
      const authored = [
        `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
        "",
        "export default defineSoftwareMap({",
        "  systems: {",
        '    app: { label: "App", containers: { core: { label: "Core", components: { readme: { label: "Readme", coverage: { files: ["README.md"] } } } } } },',
        "  },",
        "});",
        "",
      ].join("\n");
      await writeFile(scratchPath, authored, "utf8");

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["check", "HEAD"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable(stderr),
      });

      expect(stderr.join("")).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("software map: healthy");
      expect(stdout.join("")).toContain(
        `note ${SOFTWARE_MAP_NOTES_REF} written for ${commit}`,
      );
      // The flush is byte-exact: note equals scratch.
      expect(
        await readNote({ rootPath, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toBe(authored);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("blocks an element-free stub model at check (no note is flushed)", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-stub-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      // open with no notes anywhere writes the schema stub verbatim.
      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["check", "HEAD"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable(stderr),
      });

      expect(exitCode).toBe(1);
      expect(stderr.join("")).toContain("software map: error");
      expect(stderr.join("")).toContain("unauthored stub");
      // Nothing was published for ancestor hydration to propagate.
      expect(
        await readNote({ rootPath, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toBeNull();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps concurrent checks of different commits isolated (per-invocation check modules)", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-concurrent-");
    try {
      const commitA = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      execGitOutput(rootPath, [
        "commit",
        "--allow-empty",
        "-m",
        "second commit",
      ]);
      const commitB = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      const authored = (label: string) =>
        [
          `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
          "",
          "export default defineSoftwareMap({",
          "  systems: {",
          `    app: { label: ${JSON.stringify(label)}, containers: { core: { label: "Core", components: { readme: { label: "Readme", coverage: { files: ["README.md"] } } } } } },`,
          "  },",
          "});",
          "",
        ].join("\n");
      for (const [commit, rev] of [
        [commitA, commitA],
        [commitB, "HEAD"],
      ] as const) {
        await runSoftwareMapCli({
          args: ["open", rev, "--force"],
          cwd: rootPath,
          stdout: writable([]),
          stderr: writable([]),
        });
        const scratchPath = scratchSoftwareMapPath({
          repoRootPath: rootPath,
          commit,
        })!;
        await writeFile(scratchPath, authored(`Map for ${commit}`), "utf8");
      }

      // The old shared check path (dev-fast/check/<basename>) let these two
      // validations clobber each other's module file mid-import.
      const [exitA, exitB] = await Promise.all(
        [commitA, commitB].map((rev) =>
          runSoftwareMapCli({
            args: ["check", rev],
            cwd: rootPath,
            stdout: writable([]),
            stderr: writable([]),
          }),
        ),
      );
      expect(exitA).toBe(0);
      expect(exitB).toBe(0);
      expect(
        await readNote({
          rootPath,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit: commitA,
        }),
      ).toBe(authored(`Map for ${commitA}`));
      expect(
        await readNote({
          rootPath,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit: commitB,
        }),
      ).toBe(authored(`Map for ${commitB}`));
      // The per-invocation check dirs were cleaned up after import.
      const gitDir = execGitOutput(rootPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      const checkRoot = path.join(gitDir, "dev-fast", "check");
      let leftovers: string[] = [];
      try {
        leftovers = await readdir(checkRoot);
      } catch {
        // The whole check root being gone is fine too.
      }
      expect(leftovers).toEqual([]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("writes nothing when the scratch is invalid", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-bad-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      })!;
      await writeFile(
        scratchPath,
        [
          `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
          "export default defineSoftwareMap({",
          '  systems: { app: { label: "App", containers: { core: { label: "Core", components: { ghost: { label: "Ghost", coverage: { files: ["does-not-exist.ts"] } } } } } } },',
          "});",
        ].join("\n"),
        "utf8",
      );

      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["check", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable(stderr),
      });

      expect(exitCode).toBe(1);
      expect(stderr.join("")).toContain("software map: error");
      expect(stderr.join("")).toContain("does-not-exist.ts");
      // The validation gate held: no note was written.
      expect(
        await readNote({ rootPath, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toBeNull();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("asks for a revision when no scratch or review session locates one", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-norev-");
    try {
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["check", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable(stderr),
      });
      expect(exitCode).toBe(1);
      expect(stderr.join("")).toContain("No scratch exists");
      expect(stderr.join("")).toContain("review map open");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("resolves the current review's head when no rev is given", async () => {
    if (!commandExists("git")) return;
    const rawRootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-map-check-session-"),
    );
    const rootPath = await realpath(rawRootPath);
    const previousReviewHome = process.env.DEV_REVIEW_HOME;
    process.env.DEV_REVIEW_HOME = path.join(rootPath, ".dev-home");
    try {
      execGit(rootPath, ["init"]);
      execGit(rootPath, ["config", "user.email", "review@example.com"]);
      execGit(rootPath, ["config", "user.name", "Review Test"]);
      await writeFile(path.join(rootPath, "README.md"), "base\n", "utf8");
      execGit(rootPath, ["add", "README.md"]);
      execGit(rootPath, ["commit", "-m", "base"]);
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      const review = await createReviewDir({
        worktreePath: rootPath,
        baseRef: "HEAD",
        baseCommit: commit,
        sourceCommit: commit,
        sourceIdentity: { kind: "git-branch", name: "HEAD" },
      });

      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      })!;
      await writeFile(
        scratchPath,
        authoredMapSource("Active session map"),
        "utf8",
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["check", "--review", review.review.uuid],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable(stderr),
        env: { CODEX_THREAD_ID: "map-worker-1" },
      });

      expect(stderr.join("")).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain(
        `note ${SOFTWARE_MAP_NOTES_REF} written for ${commit}`,
      );
      expect(
        await readNote({ rootPath, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toContain("Active session map");
      const record = JSON.parse(
        await readFile(path.join(review.dir, "review.json"), "utf8"),
      );
      expect(record.agentSessions["codex:map-worker-1"].roles).toEqual([
        "map-worker",
      ]);
    } finally {
      if (previousReviewHome === undefined) {
        delete process.env.DEV_REVIEW_HOME;
      } else {
        process.env.DEV_REVIEW_HOME = previousReviewHome;
      }
      await rm(rawRootPath, { recursive: true, force: true });
    }
  });
});

describe("coverage validates against the target commit's tree", () => {
  it("passes for a historical commit whose tree still has the file, fails for the commit that deleted it", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-tree-");
    try {
      // Commit A adds legacy.ts; the next commit deletes it; the working
      // copy sits at the later commit.
      await writeFile(path.join(rootPath, "legacy.ts"), "legacy\n", "utf8");
      execGit(rootPath, ["add", "legacy.ts"]);
      execGit(rootPath, ["commit", "-m", "add legacy"]);
      const commitA = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      execGit(rootPath, ["rm", "-q", "legacy.ts"]);
      execGit(rootPath, ["commit", "-m", "delete legacy"]);
      const commitB = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      const claimingMap = [
        `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
        "",
        "export default defineSoftwareMap({",
        '  systems: { app: { label: "App", containers: { core: { label: "Core", components: { legacy: { label: "Legacy", coverage: { files: ["legacy.ts"] } } } } } } },',
        "});",
        "",
      ].join("\n");

      // A's scratch claims the file A's tree really has: check must PASS and
      // flush, even though the checkout no longer contains legacy.ts.
      await runSoftwareMapCli({
        args: ["open", commitA],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      const scratchA = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit: commitA,
      })!;
      await writeFile(scratchA, claimingMap, "utf8");
      const passStdout: string[] = [];
      const passStderr: string[] = [];
      const passExit = await runSoftwareMapCli({
        args: ["check", commitA],
        cwd: rootPath,
        stdout: writable(passStdout),
        stderr: writable(passStderr),
      });
      expect(passStderr.join("")).toBe("");
      expect(passExit).toBe(0);
      expect(passStdout.join("")).toContain(
        `note ${SOFTWARE_MAP_NOTES_REF} written for ${commitA}`,
      );
      expect(
        await readNote({
          rootPath,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit: commitA,
        }),
      ).toBe(claimingMap);

      // B's tree deleted the file, so the same claim must FAIL for B — and
      // the error names which tree was consulted.
      await runSoftwareMapCli({
        args: ["open", commitB, "--force"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      const scratchB = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit: commitB,
      })!;
      await writeFile(scratchB, claimingMap, "utf8");
      const failStderr: string[] = [];
      const failExit = await runSoftwareMapCli({
        args: ["check", commitB],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable(failStderr),
      });
      expect(failExit).toBe(1);
      expect(failStderr.join("")).toContain(
        `claims file "legacy.ts" missing from tree of ${commitB.slice(0, 12)}`,
      );
      expect(
        await readNote({
          rootPath,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit: commitB,
        }),
      ).toBeNull();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("matches glob coverage against a historical tree", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-tree-glob-");
    try {
      await mkdir(path.join(rootPath, "src", "old"), { recursive: true });
      await writeFile(
        path.join(rootPath, "src", "old", "thing.ts"),
        "old\n",
        "utf8",
      );
      execGit(rootPath, ["add", "src/old/thing.ts"]);
      execGit(rootPath, ["commit", "-m", "add old dir"]);
      const commitA = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      execGit(rootPath, ["rm", "-q", "-r", "src/old"]);
      execGit(rootPath, ["commit", "-m", "delete old dir"]);
      const commitB = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      const globMap = [
        `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
        "",
        "export default defineSoftwareMap({",
        '  systems: { app: { label: "App", containers: { core: { label: "Core", components: { old: { label: "Old", coverage: { globs: ["src/old/**"] } } } } } } },',
        "});",
        "",
      ].join("\n");

      await runSoftwareMapCli({
        args: ["open", commitA],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      await writeFile(
        scratchSoftwareMapPath({
          repoRootPath: rootPath,
          commit: commitA,
        })!,
        globMap,
        "utf8",
      );
      const passStderr: string[] = [];
      expect(
        await runSoftwareMapCli({
          args: ["check", commitA],
          cwd: rootPath,
          stdout: writable([]),
          stderr: writable(passStderr),
        }),
      ).toBe(0);
      expect(passStderr.join("")).toBe("");

      await runSoftwareMapCli({
        args: ["open", commitB, "--force"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      await writeFile(
        scratchSoftwareMapPath({
          repoRootPath: rootPath,
          commit: commitB,
        })!,
        globMap,
        "utf8",
      );
      const failStderr: string[] = [];
      expect(
        await runSoftwareMapCli({
          args: ["check", commitB],
          cwd: rootPath,
          stdout: writable([]),
          stderr: writable(failStderr),
        }),
      ).toBe(1);
      expect(failStderr.join("")).toContain(
        `glob "src/old/**" matches nothing in tree of ${commitB.slice(0, 12)}`,
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("ignores on-disk files the target tree does not contain (uniform tree frame)", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-check-tree-uniform-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      // The file exists on disk (uncommitted) but not in HEAD's tree: the
      // check target IS the working copy's commit, and validation is still
      // tree-based, so the claim must fail.
      await writeFile(path.join(rootPath, "uncommitted.ts"), "wip\n", "utf8");

      await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable([]),
      });
      await writeFile(
        scratchSoftwareMapPath({
          repoRootPath: rootPath,
          commit,
        })!,
        [
          `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
          "",
          "export default defineSoftwareMap({",
          '  systems: { app: { label: "App", containers: { core: { label: "Core", components: { wip: { label: "Wip", coverage: { files: ["uncommitted.ts"] } } } } } } },',
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const stderr: string[] = [];
      expect(
        await runSoftwareMapCli({
          args: ["check", "HEAD"],
          cwd: rootPath,
          stdout: writable([]),
          stderr: writable(stderr),
        }),
      ).toBe(1);
      expect(stderr.join("")).toContain(
        `claims file "uncommitted.ts" missing from tree of ${commit.slice(0, 12)}`,
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe("ancestor seeding (the quiet-diff fast path)", () => {
  it("open seeds head from base's note and prints the diff work order", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-seed-");
    try {
      const baseCommit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeFile(path.join(rootPath, "next.txt"), "next\n", "utf8");
      execGit(rootPath, ["add", "next.txt"]);
      execGit(rootPath, ["commit", "-m", "advance"]);
      const headCommit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);

      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit: baseCommit,
        content: authoredMapSource("Base map"),
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const openExit = await runSoftwareMapCli({
        args: ["open", "HEAD"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable(stderr),
      });
      expect(stderr.join("")).toBe("");
      expect(openExit).toBe(0);
      expect(stdout.join("")).toContain(
        `hydrated from the note on ${baseCommit.slice(0, 12)}, 1 commits behind HEAD; review the diff ${baseCommit.slice(0, 12)}..HEAD and update the map to match`,
      );
      // The scratch seeds byte-equal from the ancestor note.
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit: headCommit,
      })!;
      expect(await readFile(scratchPath, "utf8")).toBe(
        authoredMapSource("Base map"),
      );

      // Quiet diff: check with no edits flushes head's own note.
      const checkStdout: string[] = [];
      const checkStderr: string[] = [];
      const checkExit = await runSoftwareMapCli({
        args: ["check", "HEAD"],
        cwd: rootPath,
        stdout: writable(checkStdout),
        stderr: writable(checkStderr),
      });
      expect(checkStderr.join("")).toBe("");
      expect(checkExit).toBe(0);
      expect(checkStdout.join("")).toContain(
        `note ${SOFTWARE_MAP_NOTES_REF} written for ${headCommit}`,
      );
      expect(
        await readNote({
          rootPath,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit: headCommit,
        }),
      ).toBe(authoredMapSource("Base map"));
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe("review map prune", () => {
  it("drops notes on unreachable commits and keeps reachable ones", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-prune-");
    try {
      const keptCommit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      execGit(rootPath, ["checkout", "-q", "-b", "doomed"]);
      await writeFile(path.join(rootPath, "doomed.txt"), "doomed\n", "utf8");
      execGit(rootPath, ["add", "doomed.txt"]);
      execGit(rootPath, ["commit", "-q", "-m", "doomed"]);
      const doomedCommit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      execGit(rootPath, ["checkout", "-q", "main"]);
      execGit(rootPath, ["branch", "-q", "-D", "doomed"]);
      execGit(rootPath, ["reflog", "expire", "--expire=now", "--all"]);

      for (const commit of [keptCommit, doomedCommit]) {
        await writeNote({
          rootPath,
          ref: SOFTWARE_MAP_NOTES_REF,
          commit,
          content: authoredMapSource(`map ${commit.slice(0, 7)}`),
        });
      }

      const stdout: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["prune"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });

      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("pruned 1 note(s)");
      expect(
        await listNoteCommits({ rootPath, ref: SOFTWARE_MAP_NOTES_REF }),
      ).toEqual([keptCommit]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("deletes a scratch whose canonicalized content equals its commit's note", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-prune-scratch-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      const content = authoredMapSource("Flushed map");
      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content,
      });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      });
      if (!scratchPath) throw new Error("expected a scratch path");
      await mkdir(path.dirname(scratchPath), { recursive: true });
      // The scratch spells the model import relatively; only the canonicalized
      // comparison (the same rewrite check's flush pipeline applies) makes it
      // byte-equal to the note.
      await writeFile(
        scratchPath,
        content.replace(
          CANONICAL_SOFTWARE_MAP_MODEL_IMPORT,
          "./software-map-model",
        ),
        "utf8",
      );

      const stdout: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["prune"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });

      expect(exitCode).toBe(0);
      const output = stdout.join("");
      expect(output).toContain(
        `scratch ${commit.slice(0, 12)}: deleted (flushed to its note)`,
      );
      expect(output).toContain("scratch: 1 deleted, 0 kept");
      expect(await readFile(scratchPath, "utf8").catch(() => null)).toBeNull();
      // The note itself is untouched: open can re-hydrate the scratch.
      expect(
        await readNote({ rootPath, ref: SOFTWARE_MAP_NOTES_REF, commit }),
      ).toBe(content);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps a dirty scratch (content differs from the note)", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-prune-dirty-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: authoredMapSource("Flushed version"),
      });
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      });
      if (!scratchPath) throw new Error("expected a scratch path");
      await mkdir(path.dirname(scratchPath), { recursive: true });
      const dirtyContent = authoredMapSource("Unflushed edits");
      await writeFile(scratchPath, dirtyContent, "utf8");

      const stdout: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["prune"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });

      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("scratch: 0 deleted, 1 kept");
      expect(await readFile(scratchPath, "utf8")).toBe(dirtyContent);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps a scratch whose commit has no note", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-prune-no-note-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      const scratchPath = scratchSoftwareMapPath({
        repoRootPath: rootPath,
        commit,
      });
      if (!scratchPath) throw new Error("expected a scratch path");
      await mkdir(path.dirname(scratchPath), { recursive: true });
      const unflushedContent = authoredMapSource("Never flushed");
      await writeFile(scratchPath, unflushedContent, "utf8");

      const stdout: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["prune"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });

      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("scratch: 0 deleted, 1 kept");
      expect(await readFile(scratchPath, "utf8")).toBe(unflushedContent);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe("review map push / fetch", () => {
  it("pushes notes through an explicit writable remote", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-push-remote-");
    const bareDir = await mkdtemp(path.join(os.tmpdir(), "review-map-fork-"));
    try {
      execGit(bareDir, ["init", "--bare"]);
      execGit(rootPath, ["remote", "add", "fork", bareDir]);
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: authoredMapSource("Fork map"),
      });
      const stdout: string[] = [];

      const exitCode = await runSoftwareMapCli({
        args: ["push", "--remote", "fork", "--json"],
        cwd: rootPath,
        stdout: writable(stdout),
        stderr: writable([]),
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        event: "map-push",
        remote: "fork",
      });
      expect(
        execGitOutput(bareDir, ["show-ref", SOFTWARE_MAP_NOTES_REF]),
      ).toContain(SOFTWARE_MAP_NOTES_REF);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(bareDir, { recursive: true, force: true });
    }
  });

  it("shares notes through a bare origin", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-push-");
    const bareDir = await mkdtemp(path.join(os.tmpdir(), "review-map-origin-"));
    const cloneParent = await mkdtemp(
      path.join(os.tmpdir(), "review-map-clone-"),
    );
    try {
      execGit(bareDir, ["init", "--bare"]);
      execGit(rootPath, ["remote", "add", "origin", bareDir]);
      execGit(rootPath, ["push", "-q", "origin", "HEAD:main"]);
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: authoredMapSource("Shared map"),
      });

      const pushStdout: string[] = [];
      const pushExit = await runSoftwareMapCli({
        args: ["push"],
        cwd: rootPath,
        stdout: writable(pushStdout),
        stderr: writable([]),
      });
      expect(pushExit).toBe(0);
      expect(pushStdout.join("")).toContain(SOFTWARE_MAP_NOTES_REF);

      execGit(cloneParent, ["clone", "-q", bareDir, "clone"]);
      const clonePath = path.join(cloneParent, "clone");
      const fetchStdout: string[] = [];
      const fetchExit = await runSoftwareMapCli({
        args: ["fetch"],
        cwd: clonePath,
        stdout: writable(fetchStdout),
        stderr: writable([]),
      });
      expect(fetchExit).toBe(0);
      const remoteNote = await readNote({
        rootPath: clonePath,
        ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
        commit,
      });
      expect(remoteNote).toContain("Shared map");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(bareDir, { recursive: true, force: true });
      await rm(cloneParent, { recursive: true, force: true });
    }
  });

  it("push fails soft against an unreachable origin", async () => {
    if (!commandExists("git")) return;
    const rootPath = await gitFixture("review-map-push-bad-");
    try {
      const commit = execGitOutput(rootPath, ["rev-parse", "HEAD"]);
      await writeNote({
        rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
        content: authoredMapSource("Unpushable map"),
      });
      execGit(rootPath, [
        "remote",
        "add",
        "origin",
        path.join(os.tmpdir(), "missing-origin.git"),
      ]);
      const stderr: string[] = [];
      const exitCode = await runSoftwareMapCli({
        args: ["push"],
        cwd: rootPath,
        stdout: writable([]),
        stderr: writable(stderr),
      });
      expect(exitCode).toBe(1);
      expect(stderr.join("")).toContain("software map push failed");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

function writable(chunks: string[]): Writable {
  return collectingWritable(chunks);
}

function authoredMapSource(label: string): string {
  return [
    `import { defineSoftwareMap } from "${CANONICAL_SOFTWARE_MAP_MODEL_IMPORT}";`,
    "",
    `export default defineSoftwareMap({ systems: { app: { label: ${JSON.stringify(
      label,
    )} } } });`,
    "",
  ].join("\n");
}

async function gitFixture(prefix: string): Promise<string> {
  const rawRootPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootPath = await realpath(rawRootPath);
  execGit(rootPath, ["init", "-b", "main"]);
  execGit(rootPath, ["config", "user.email", "review@example.com"]);
  execGit(rootPath, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(rootPath, "README.md"), "base\n", "utf8");
  execGit(rootPath, ["add", "README.md"]);
  execGit(rootPath, ["commit", "-m", "base"]);
  return rootPath;
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
