import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitCommonDir } from ".";
import {
  DEV_FAST_NOTES_FETCH_REFSPEC,
  NotesLockTimeoutError,
  clearNotesConfigCacheForTests,
  copyNote,
  ensureNotesConfig,
  evologCommitIds,
  fetchNotes,
  listNoteCommits,
  notesLockPathForTests,
  pruneNotes,
  pushNotes,
  readNote,
  readNoteSync,
  readNotesBatch,
  remoteNotesRef,
  setNotesLockTimeoutsForTests,
  writeNote,
  writeNoteSync,
} from "./notes";

const MAP_REF = "refs/notes/dev-fast/software-map";

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return run(cwd, "git", args);
}

async function initGitRepo(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "notes-git-"));
  git(rootPath, ["init", "-q", "-b", "main"]);
  git(rootPath, ["config", "user.email", "test@example.com"]);
  git(rootPath, ["config", "user.name", "Test User"]);
  return rootPath;
}

function commit(rootPath: string, message: string): string {
  git(rootPath, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(rootPath, ["rev-parse", "HEAD"]);
}

function hasJj(): boolean {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function initJjRepo(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "notes-jj-prune-"));
  run(rootPath, "jj", ["git", "init", "--colocate"]);
  git(rootPath, ["config", "user.email", "test@example.com"]);
  git(rootPath, ["config", "user.name", "Test User"]);
  run(rootPath, "jj", ["describe", "-m", "working copy"]);
  return rootPath;
}

function jjCommitId(rootPath: string): string {
  return run(rootPath, "jj", [
    "log",
    "-r",
    "@",
    "--no-graph",
    "-T",
    "commit_id",
  ]);
}

beforeEach(() => {
  clearNotesConfigCacheForTests();
});

afterEach(() => {
  setNotesLockTimeoutsForTests(null);
});

async function lockPathFor(rootPath: string): Promise<string> {
  const gitDir = await gitCommonDir(rootPath);
  if (!gitDir) throw new Error("no git dir");
  return notesLockPathForTests(gitDir);
}

function plantForeignLock(lockPath: string): void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  mkdirSync(lockPath);
}

describe("notes locking", () => {
  it("fails the operation on lock timeout and never deletes the other holder's lock", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    const lockPath = await lockPathFor(rootPath);
    plantForeignLock(lockPath);
    setNotesLockTimeoutsForTests({ asyncMs: 200, syncMs: 200 });

    await expect(
      writeNote({ rootPath, ref: MAP_REF, commit: head, content: "blocked" }),
    ).rejects.toBeInstanceOf(NotesLockTimeoutError);
    // The critical section never ran unlocked...
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBeNull();
    // ...and the other holder's lock file survived the failure.
    expect(existsSync(lockPath)).toBe(true);
  });

  it("fails writeNoteSync fast on lock timeout without spinning the full async budget", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    const lockPath = await lockPathFor(rootPath);
    plantForeignLock(lockPath);
    setNotesLockTimeoutsForTests({ syncMs: 150 });

    const startedAt = Date.now();
    expect(() =>
      writeNoteSync({ rootPath, ref: MAP_REF, commit: head, content: "sync" }),
    ).toThrowError(NotesLockTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(existsSync(lockPath)).toBe(true);
    expect(readNoteSync({ rootPath, ref: MAP_REF, commit: head })).toBeNull();
  });

  it("reclaims an abandoned stale lock and completes the write", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    const lockPath = await lockPathFor(rootPath);
    plantForeignLock(lockPath);
    const old = new Date(Date.now() - 10 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, old, old);
    setNotesLockTimeoutsForTests({ asyncMs: 2_000 });

    await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "ok" });
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe("ok");
    // The write released its own lock on the way out.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("waits on a corrupt lock until it becomes stale", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    const lockPath = await lockPathFor(rootPath);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "not json");
    setNotesLockTimeoutsForTests({ asyncMs: 200 });
    await expect(
      writeNote({ rootPath, ref: MAP_REF, commit: head, content: "wait" }),
    ).rejects.toBeInstanceOf(NotesLockTimeoutError);

    // Backdated beyond the stale window, an owner-less lock is reclaimable.
    const old = new Date(Date.now() - 10 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, old, old);
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "ok" });
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe("ok");
  });
});

describe("git notes primitives", () => {
  it("round-trips note content byte-for-byte (no stripspace mangling)", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    // Deliberately hostile to stripspace: consecutive blank lines, trailing
    // whitespace, leading blank line, no trailing newline.
    const content = `\nimport { defineSoftwareMap } from "@dev.fast/progressive-review/software-map-model";\n\n\nexport default defineSoftwareMap({\n  people: {},  \n\n\n  systems: {},\n});`;
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content });
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe(
      content,
    );
    expect(readNoteSync({ rootPath, ref: MAP_REF, commit: head })).toBe(
      content,
    );
  });

  it("round-trips CRLF bytes through a repo with hostile text attributes (--no-filters)", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    // `* text` + autocrlf would run CRLF→LF conversion in hash-object unless
    // the writer passes --no-filters; notes are a byte-for-byte contract.
    const gitDir = await gitCommonDir(rootPath);
    if (!gitDir) throw new Error("no git dir");
    mkdirSync(path.join(gitDir, "info"), { recursive: true });
    writeFileSync(path.join(gitDir, "info", "attributes"), "* text\n");
    git(rootPath, ["config", "core.autocrlf", "true"]);

    const content = "line one\r\nline two\r\n\r\nno trailing newline\r";
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content });
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe(
      content,
    );

    const syncCommit = commit(rootPath, "two");
    writeNoteSync({ rootPath, ref: MAP_REF, commit: syncCommit, content });
    expect(readNoteSync({ rootPath, ref: MAP_REF, commit: syncCommit })).toBe(
      content,
    );
  });

  it("pruneNotes runs under the notes lock (a held lock fails it, not interleaves)", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "map" });
    const lockPath = await lockPathFor(rootPath);
    plantForeignLock(lockPath);
    setNotesLockTimeoutsForTests({ asyncMs: 200 });
    await expect(pruneNotes({ rootPath, ref: MAP_REF })).rejects.toBeInstanceOf(
      NotesLockTimeoutError,
    );
    expect(existsSync(lockPath)).toBe(true);
  });

  it("overwrites an existing note (last writer wins)", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "v1" });
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "v2" });
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe("v2");
  });

  it("returns null / empty for missing refs and unannotated commits", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBeNull();
    const annotated = commit(rootPath, "two");
    await writeNote({
      rootPath,
      ref: MAP_REF,
      commit: annotated,
      content: "map",
    });
    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBeNull();
    expect(await listNoteCommits({ rootPath, ref: MAP_REF })).toEqual([
      annotated,
    ]);
  });

  it("batch-reads many notes with one process pair", async () => {
    const rootPath = await initGitRepo();
    const commits: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const sha = commit(rootPath, `c${index}`);
      commits.push(sha);
      await writeNote({
        rootPath,
        ref: MAP_REF,
        commit: sha,
        content: `map ${index}`,
      });
    }
    const unannotated = commit(rootPath, "no-note");
    const batch = await readNotesBatch({
      rootPath,
      ref: MAP_REF,
      commits: [...commits, unannotated],
    });
    expect(batch.size).toBe(25);
    for (const [index, sha] of commits.entries()) {
      expect(batch.get(sha)).toBe(`map ${index}`);
    }
    expect(batch.has(unannotated)).toBe(false);
  });

  it("reads notes stored in a fanout tree layout", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    const gitDir = await gitCommonDir(rootPath);
    if (!gitDir) throw new Error("no git dir");
    // Manually build a 2/38 fanout notes tree: ab/cdef... -> blob.
    const realBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: rootPath,
      input: "fanout map content",
      encoding: "utf8",
    }).trim();
    const inner = execFileSync("git", ["mktree"], {
      cwd: rootPath,
      input: `100644 blob ${realBlob}\t${head.slice(2)}\n`,
      encoding: "utf8",
    }).trim();
    const outer = execFileSync("git", ["mktree"], {
      cwd: rootPath,
      input: `040000 tree ${inner}\t${head.slice(0, 2)}\n`,
      encoding: "utf8",
    }).trim();
    const notesCommit = git(rootPath, [
      "commit-tree",
      outer,
      "-m",
      "Notes added by test",
    ]);
    git(rootPath, ["update-ref", MAP_REF, notesCommit]);

    expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe(
      "fanout map content",
    );
  });

  it("survives concurrent writers via the notes lock", async () => {
    const rootPath = await initGitRepo();
    const commits = [
      commit(rootPath, "a"),
      commit(rootPath, "b"),
      commit(rootPath, "c"),
      commit(rootPath, "d"),
    ];
    await Promise.all(
      commits.map((sha, index) =>
        writeNote({
          rootPath,
          ref: MAP_REF,
          commit: sha,
          content: `concurrent ${index}`,
        }),
      ),
    );
    for (const [index, sha] of commits.entries()) {
      expect(await readNote({ rootPath, ref: MAP_REF, commit: sha })).toBe(
        `concurrent ${index}`,
      );
    }
  });

  it("serializes notes writes from independent processes", async () => {
    const rootPath = await initGitRepo();
    const commits = Array.from({ length: 6 }, (_, index) =>
      commit(rootPath, `process ${index}`),
    );
    const barrierPath = path.join(rootPath, "notes-workers.start");
    const workerPath = fileURLToPath(
      new URL("./test-fixtures/notes-write-worker.ts", import.meta.url),
    );
    const workers = commits.map((sha, index) => {
      const readyPath = path.join(rootPath, `notes-worker-${index}.ready`);
      return {
        promise: runNotesWorker(workerPath, [
          rootPath,
          MAP_REF,
          sha,
          `process content ${index}`,
          barrierPath,
          readyPath,
        ]),
        readyPath,
      };
    });

    await waitFor(() =>
      workers.every(({ readyPath }) => existsSync(readyPath)),
    );
    writeFileSync(barrierPath, "go");
    await Promise.all(workers.map(({ promise }) => promise));

    for (const [index, sha] of commits.entries()) {
      expect(await readNote({ rootPath, ref: MAP_REF, commit: sha })).toBe(
        `process content ${index}`,
      );
    }
  }, 15_000);

  it("copyNote carries a note across a rewrite and reports misses", async () => {
    const rootPath = await initGitRepo();
    const oldCommit = commit(rootPath, "old");
    const newCommit = commit(rootPath, "new");
    expect(
      await copyNote({
        rootPath,
        ref: MAP_REF,
        from: oldCommit,
        to: newCommit,
      }),
    ).toBe(false);
    await writeNote({
      rootPath,
      ref: MAP_REF,
      commit: oldCommit,
      content: "carried",
    });
    expect(
      await copyNote({
        rootPath,
        ref: MAP_REF,
        from: oldCommit,
        to: newCommit,
      }),
    ).toBe(true);
    expect(await readNote({ rootPath, ref: MAP_REF, commit: newCommit })).toBe(
      "carried",
    );
  });

  it("pruneNotes drops entries for commits that were GC'd", async () => {
    const rootPath = await initGitRepo();
    commit(rootPath, "keep-base");
    git(rootPath, ["checkout", "-q", "-b", "doomed"]);
    const doomed = commit(rootPath, "doomed");
    await writeNote({
      rootPath,
      ref: MAP_REF,
      commit: doomed,
      content: "orphan",
    });
    git(rootPath, ["checkout", "-q", "main"]);
    git(rootPath, ["branch", "-q", "-D", "doomed"]);
    git(rootPath, ["reflog", "expire", "--expire=now", "--all"]);
    git(rootPath, ["gc", "-q", "--prune=now"]);

    expect(await listNoteCommits({ rootPath, ref: MAP_REF })).toEqual([doomed]);
    expect(await pruneNotes({ rootPath, ref: MAP_REF })).toEqual({
      removed: [doomed],
    });
    expect(await listNoteCommits({ rootPath, ref: MAP_REF })).toEqual([]);
  });

  it("pruneNotes drops notes on existing-but-unreachable commits and keeps reachable ones", async () => {
    const rootPath = await initGitRepo();
    const kept = commit(rootPath, "kept");
    git(rootPath, ["checkout", "-q", "-b", "doomed"]);
    const doomed = commit(rootPath, "doomed");
    git(rootPath, ["checkout", "-q", "main"]);
    git(rootPath, ["branch", "-q", "-D", "doomed"]);
    git(rootPath, ["reflog", "expire", "--expire=now", "--all"]);
    // No gc: the doomed commit still exists as an object, but no ref
    // reaches it.
    for (const target of [kept, doomed]) {
      await writeNote({
        rootPath,
        ref: MAP_REF,
        commit: target,
        content: `map for ${target}`,
      });
    }

    const pruned = await pruneNotes({ rootPath, ref: MAP_REF });
    expect(pruned.removed).toEqual([doomed]);
    expect(await listNoteCommits({ rootPath, ref: MAP_REF })).toEqual([kept]);
    expect(await readNote({ rootPath, ref: MAP_REF, commit: kept })).toBe(
      `map for ${kept}`,
    );
  });

  it.skipIf(!hasJj())(
    "pruneNotes spares the newest annotated evolog predecessor of a live change and prunes older ones",
    async () => {
      const rootPath = await initJjRepo();
      // Author a note, rewrite the change (stranding the note on a dead
      // predecessor commit id), author again, rewrite again. The change's
      // evolog now holds two annotated predecessors and an unannotated `@`.
      const older = jjCommitId(rootPath);
      await writeNote({
        rootPath,
        ref: MAP_REF,
        commit: older,
        content: "older predecessor map",
      });
      run(rootPath, "jj", ["describe", "-m", "second version"]);
      const newest = jjCommitId(rootPath);
      await writeNote({
        rootPath,
        ref: MAP_REF,
        commit: newest,
        content: "newest predecessor map",
      });
      run(rootPath, "jj", ["describe", "-m", "third version"]);
      const current = jjCommitId(rootPath);
      expect(new Set([older, newest, current]).size).toBe(3);

      // jj anchors commits with refs/jj/keep/* until `jj util gc` expires
      // them; drop the predecessors' anchors to simulate that expiry. The
      // evolog (jj's op store) still records both predecessors.
      for (const predecessor of [older, newest]) {
        git(rootPath, ["update-ref", "-d", `refs/jj/keep/${predecessor}`]);
      }

      // Reachability alone would now sweep both predecessors — no git ref
      // reaches them and neither is any workspace's `@`. But `newest` is the
      // note evolog recovery would backfill onto `current`; prune must spare
      // it, while the older annotated predecessor stays prunable.
      const pruned = await pruneNotes({ rootPath, ref: MAP_REF });
      expect(pruned.removed).toEqual([older]);
      expect(await readNote({ rootPath, ref: MAP_REF, commit: newest })).toBe(
        "newest predecessor map",
      );
      expect(
        await readNote({ rootPath, ref: MAP_REF, commit: older }),
      ).toBeNull();
    },
  );

  it.skipIf(!hasJj())(
    "pruneNotes keeps unreachable commits that are a jj workspace's @",
    async () => {
      const rootPath = await initJjRepo();
      const workingCopy = jjCommitId(rootPath);
      // jj working-copy commits are real commits no git ref points at.
      await writeNote({
        rootPath,
        ref: MAP_REF,
        commit: workingCopy,
        content: "working copy map",
      });

      const pruned = await pruneNotes({ rootPath, ref: MAP_REF });
      expect(pruned.removed).toEqual([]);
      expect(
        await readNote({ rootPath, ref: MAP_REF, commit: workingCopy }),
      ).toBe("working copy map");
    },
  );
});

async function runNotesWorker(
  workerPath: string,
  args: string[],
): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, ...args],
    {
      cwd: path.resolve(fileURLToPath(new URL("../../..", import.meta.url))),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else
        rejectExit(
          new Error(
            `Notes worker failed (${signal ?? code ?? "unknown"}): ${stderr}`,
          ),
        );
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for notes workers.");
}

describe("notes config and rewrite handling", () => {
  it("ensureNotesConfig is idempotent and installs the fetch refspec", async () => {
    const rootPath = await initGitRepo();
    commit(rootPath, "one");
    const bare = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    git(bare, ["init", "-q", "--bare"]);
    git(rootPath, ["remote", "add", "origin", bare]);

    await ensureNotesConfig({ rootPath });
    clearNotesConfigCacheForTests();
    await ensureNotesConfig({ rootPath });

    const rewriteRefs = git(rootPath, [
      "config",
      "--get-all",
      "notes.rewriteRef",
    ]).split("\n");
    expect(rewriteRefs).toEqual(["refs/notes/dev-fast/*"]);
    expect(git(rootPath, ["config", "notes.rewriteMode"])).toBe("overwrite");
    const fetchSpecs = git(rootPath, [
      "config",
      "--get-all",
      "remote.origin.fetch",
    ])
      .split("\n")
      .filter((line) => line.includes("dev-fast"));
    expect(fetchSpecs).toEqual([DEV_FAST_NOTES_FETCH_REFSPEC]);
  });

  it("ensureNotesConfig skips the fetch refspec while devFast.fetchNotes=false and installs it once re-enabled", async () => {
    const rootPath = await initGitRepo();
    commit(rootPath, "one");
    const bare = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    git(bare, ["init", "-q", "--bare"]);
    git(rootPath, ["remote", "add", "origin", bare]);
    git(rootPath, ["config", "devFast.fetchNotes", "false"]);

    await ensureNotesConfig({ rootPath });
    const disabledSpecs = git(rootPath, [
      "config",
      "--get-all",
      "remote.origin.fetch",
    ])
      .split("\n")
      .filter((line) => line.includes("dev-fast"));
    expect(disabledSpecs).toEqual([]);
    // The rewrite config still installs (it is not fetch-related).
    expect(git(rootPath, ["config", "notes.rewriteMode"])).toBe("overwrite");

    // Re-enabling must not be memo-poisoned: the SAME process installs the
    // refspec on the next ensure (no cache clear here on purpose).
    git(rootPath, ["config", "--unset", "devFast.fetchNotes"]);
    await ensureNotesConfig({ rootPath });
    const enabledSpecs = git(rootPath, [
      "config",
      "--get-all",
      "remote.origin.fetch",
    ])
      .split("\n")
      .filter((line) => line.includes("dev-fast"));
    expect(enabledSpecs).toEqual([DEV_FAST_NOTES_FETCH_REFSPEC]);
  });

  it("installs the fetch refspec on the configured notes remote", async () => {
    const rootPath = await initGitRepo();
    commit(rootPath, "one");
    const origin = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    const fork = await mkdtemp(path.join(tmpdir(), "notes-fork-"));
    git(origin, ["init", "-q", "--bare"]);
    git(fork, ["init", "-q", "--bare"]);
    git(rootPath, ["remote", "add", "origin", origin]);
    git(rootPath, ["remote", "add", "fork", fork]);
    git(rootPath, ["config", "devFast.notesRemote", "fork"]);

    await ensureNotesConfig({ rootPath });

    expect(
      git(rootPath, ["config", "--get-all", "remote.fork.fetch"])
        .split("\n")
        .filter((line) => line.includes("dev-fast")),
    ).toEqual([DEV_FAST_NOTES_FETCH_REFSPEC]);
    expect(
      git(rootPath, ["config", "--get-all", "remote.origin.fetch"])
        .split("\n")
        .filter((line) => line.includes("dev-fast")),
    ).toEqual([]);
  });

  it("notes.rewriteRef carries a note across git commit --amend", async () => {
    const rootPath = await initGitRepo();
    const original = commit(rootPath, "will amend");
    await writeNote({
      rootPath,
      ref: MAP_REF,
      commit: original,
      content: "survives amend",
    });
    git(rootPath, [
      "commit",
      "-q",
      "--amend",
      "--allow-empty",
      "-m",
      "amended",
    ]);
    const amended = git(rootPath, ["rev-parse", "HEAD"]);
    expect(amended).not.toBe(original);
    expect(await readNote({ rootPath, ref: MAP_REF, commit: amended })).toBe(
      "survives amend",
    );
  });
});

describe("notes sharing", () => {
  it("uses devFast.notesRemote when no remote override is supplied", async () => {
    const publisher = await initGitRepo();
    const head = commit(publisher, "shared through fork");
    const fork = await mkdtemp(path.join(tmpdir(), "notes-fork-"));
    git(fork, ["init", "-q", "--bare"]);
    git(publisher, ["remote", "add", "fork", fork]);
    git(publisher, ["config", "devFast.notesRemote", "fork"]);
    await writeNote({
      rootPath: publisher,
      ref: MAP_REF,
      commit: head,
      content: "fork map",
    });

    const pushed = await pushNotes({ rootPath: publisher, refs: [MAP_REF] });

    expect(pushed).toMatchObject({ ok: true, pushed: [MAP_REF] });
    expect(git(fork, ["ls-remote", ".", MAP_REF])).toContain(MAP_REF);
  });

  it("pushes and fetches notes through a bare origin into the remote namespace", async () => {
    const publisher = await initGitRepo();
    const head = commit(publisher, "shared");
    const bare = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    git(bare, ["init", "-q", "--bare"]);
    git(publisher, ["remote", "add", "origin", bare]);
    git(publisher, ["push", "-q", "origin", "main"]);
    await writeNote({
      rootPath: publisher,
      ref: MAP_REF,
      commit: head,
      content: "published map",
    });

    const pushed = await pushNotes({
      rootPath: publisher,
      refs: [MAP_REF, "refs/notes/dev-fast/unannotated"],
    });
    expect(pushed.ok).toBe(true);
    expect(pushed.pushed).toEqual([MAP_REF]);
    expect(git(bare, ["ls-remote", ".", "refs/notes/*"])).toContain(MAP_REF);

    const consumer = await mkdtemp(path.join(tmpdir(), "notes-consumer-"));
    git(consumer, ["clone", "-q", bare, "clone"]);
    const clonePath = path.join(consumer, "clone");
    const fetched = await fetchNotes({ rootPath: clonePath });
    expect(fetched.ok).toBe(true);
    expect(
      await readNote({
        rootPath: clonePath,
        ref: remoteNotesRef(MAP_REF),
        commit: head,
      }),
    ).toBe("published map");
    // Local namespace untouched by the fetch.
    expect(
      await readNote({ rootPath: clonePath, ref: MAP_REF, commit: head }),
    ).toBeNull();
  });

  it("fetchNotes honors the devFast.fetchNotes=false kill-switch", async () => {
    const publisher = await initGitRepo();
    const head = commit(publisher, "shared");
    const bare = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    git(bare, ["init", "-q", "--bare"]);
    git(publisher, ["remote", "add", "origin", bare]);
    git(publisher, ["push", "-q", "origin", "main"]);
    await writeNote({
      rootPath: publisher,
      ref: MAP_REF,
      commit: head,
      content: "published map",
    });
    await pushNotes({ rootPath: publisher, refs: [MAP_REF] });

    const consumer = await mkdtemp(path.join(tmpdir(), "notes-consumer-"));
    git(consumer, ["clone", "-q", bare, "clone"]);
    const clonePath = path.join(consumer, "clone");
    git(clonePath, ["config", "devFast.fetchNotes", "false"]);

    const fetched = await fetchNotes({ rootPath: clonePath });
    expect(fetched).toEqual({ ok: true, skipped: true });
    // No fetch was attempted: the remote namespace stayed empty even though
    // origin has the note.
    expect(
      await readNote({
        rootPath: clonePath,
        ref: remoteNotesRef(MAP_REF),
        commit: head,
      }),
    ).toBeNull();

    // Any other value (or unset) keeps fetching enabled.
    git(clonePath, ["config", "devFast.fetchNotes", "please"]);
    const refetched = await fetchNotes({ rootPath: clonePath });
    expect(refetched.ok).toBe(true);
    expect(refetched.skipped).toBeUndefined();
    expect(
      await readNote({
        rootPath: clonePath,
        ref: remoteNotesRef(MAP_REF),
        commit: head,
      }),
    ).toBe("published map");
  });

  it("pushNotes reconciles diverged notes histories with an entry-level union", async () => {
    // Two writers share an origin. Alice pushes a note for commit A; Bob —
    // whose notes ref never saw Alice's push — writes a note for commit B
    // and pushes. A plain non-fast-forward push would wedge Bob forever;
    // reconciliation must union the entries and land both on origin.
    const alice = await initGitRepo();
    const commitA = commit(alice, "a");
    const commitB = commit(alice, "b");
    const bare = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    git(bare, ["init", "-q", "--bare"]);
    git(alice, ["remote", "add", "origin", bare]);
    git(alice, ["push", "-q", "origin", "main"]);

    const bobParent = await mkdtemp(path.join(tmpdir(), "notes-bob-"));
    git(bobParent, ["clone", "-q", bare, "clone"]);
    const bob = path.join(bobParent, "clone");
    git(bob, ["config", "user.email", "bob@example.com"]);
    git(bob, ["config", "user.name", "Bob"]);

    await writeNote({
      rootPath: alice,
      ref: MAP_REF,
      commit: commitA,
      content: "alice map A",
    });
    expect(await pushNotes({ rootPath: alice, refs: [MAP_REF] })).toMatchObject(
      { ok: true, pushed: [MAP_REF] },
    );

    // Bob's local notes ref diverges: no entry for A, a new entry for B.
    await writeNote({
      rootPath: bob,
      ref: MAP_REF,
      commit: commitB,
      content: "bob map B",
    });
    expect(await pushNotes({ rootPath: bob, refs: [MAP_REF] })).toMatchObject({
      ok: true,
      pushed: [MAP_REF],
    });

    // Origin now carries BOTH entries (fetch back into Alice to verify).
    await fetchNotes({ rootPath: alice });
    const remoteRef = remoteNotesRef(MAP_REF);
    expect(
      await readNote({ rootPath: alice, ref: remoteRef, commit: commitA }),
    ).toBe("alice map A");
    expect(
      await readNote({ rootPath: alice, ref: remoteRef, commit: commitB }),
    ).toBe("bob map B");
    // Bob adopted Alice's remote-only entry into his local ref too.
    expect(
      await readNote({ rootPath: bob, ref: MAP_REF, commit: commitA }),
    ).toBe("alice map A");
  });

  it("pushNotes keeps the local entry when both sides annotated the same commit", async () => {
    const alice = await initGitRepo();
    const shared = commit(alice, "shared");
    const bare = await mkdtemp(path.join(tmpdir(), "notes-origin-"));
    git(bare, ["init", "-q", "--bare"]);
    git(alice, ["remote", "add", "origin", bare]);
    git(alice, ["push", "-q", "origin", "main"]);

    const bobParent = await mkdtemp(path.join(tmpdir(), "notes-bob-"));
    git(bobParent, ["clone", "-q", bare, "clone"]);
    const bob = path.join(bobParent, "clone");
    git(bob, ["config", "user.email", "bob@example.com"]);
    git(bob, ["config", "user.name", "Bob"]);

    await writeNote({
      rootPath: alice,
      ref: MAP_REF,
      commit: shared,
      content: "alice version",
    });
    await pushNotes({ rootPath: alice, refs: [MAP_REF] });

    await writeNote({
      rootPath: bob,
      ref: MAP_REF,
      commit: shared,
      content: "bob version",
    });
    // Per-entry last-push-wins: Bob's local entry for the contested commit
    // survives his push.
    expect(await pushNotes({ rootPath: bob, refs: [MAP_REF] })).toMatchObject({
      ok: true,
      pushed: [MAP_REF],
    });
    await fetchNotes({ rootPath: alice });
    expect(
      await readNote({
        rootPath: alice,
        ref: remoteNotesRef(MAP_REF),
        commit: shared,
      }),
    ).toBe("bob version");
  });

  it("pushNotes fails soft against an unwritable remote", async () => {
    const rootPath = await initGitRepo();
    const head = commit(rootPath, "one");
    await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "map" });
    git(rootPath, [
      "remote",
      "add",
      "origin",
      path.join(tmpdir(), "does-not-exist.git"),
    ]);
    const pushed = await pushNotes({ rootPath, refs: [MAP_REF] });
    expect(pushed.ok).toBe(false);
    expect(pushed.error).toBeTruthy();
  });
});

describe("jj integration", () => {
  it.skipIf(!hasJj())(
    "evologCommitIds lists predecessors after a jj rewrite",
    async () => {
      const rootPath = await mkdtemp(path.join(tmpdir(), "notes-jj-"));
      run(rootPath, "jj", ["git", "init", "--colocate"]);
      git(rootPath, ["config", "user.email", "test@example.com"]);
      git(rootPath, ["config", "user.name", "Test User"]);
      run(rootPath, "jj", ["describe", "-m", "original"]);
      const original = run(rootPath, "jj", [
        "log",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "commit_id",
      ]);
      await writeNote({
        rootPath,
        ref: MAP_REF,
        commit: original,
        content: "map of change",
      });
      run(rootPath, "jj", ["describe", "-m", "rewritten"]);
      const rewritten = run(rootPath, "jj", [
        "log",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "commit_id",
      ]);
      expect(rewritten).not.toBe(original);
      expect(
        await readNote({ rootPath, ref: MAP_REF, commit: rewritten }),
      ).toBeNull();
      const evolog = await evologCommitIds({ rootPath, ref: rewritten });
      expect(evolog[0]).toBe(rewritten);
      expect(evolog).toContain(original);
    },
  );

  it.skipIf(!hasJj())(
    "works against a colocated jj repo's git dir",
    async () => {
      const rootPath = await mkdtemp(path.join(tmpdir(), "notes-jj-git-"));
      run(rootPath, "jj", ["git", "init", "--colocate"]);
      git(rootPath, ["config", "user.email", "test@example.com"]);
      git(rootPath, ["config", "user.name", "Test User"]);
      run(rootPath, "jj", ["describe", "-m", "change"]);
      const head = run(rootPath, "jj", [
        "log",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "commit_id",
      ]);
      await writeNote({ rootPath, ref: MAP_REF, commit: head, content: "jj" });
      expect(await readNote({ rootPath, ref: MAP_REF, commit: head })).toBe(
        "jj",
      );
    },
  );
});
