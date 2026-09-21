import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createBlobBatchReader, objectStoreArgs } from ".";
import { BlobBatchReader } from "./blob-batch-reader";
import { setLocalVcsCommandObserver } from "./exec";

const headerLike = "deadbeef blob 3\nabc\n";

const large = `${"large line of pinned text\n".repeat(4000)}`;

const binary = Buffer.from(
  Array.from({ length: 512 }, (_, index) => index % 256),
);

const spawns: string[][] = [];

const recordSpawns = () => {
  spawns.length = 0;
  setLocalVcsCommandObserver({
    start: ({ file, args }) => {
      spawns.push([file, ...args]);

      return () => {};
    },
  });
};

const batchSpawns = () =>
  spawns.filter((spawn) => spawn.includes("cat-file")).length;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const opened: BlobBatchReader[] = [];

const track = (reader: BlobBatchReader) => {
  opened.push(reader);

  return reader;
};

afterEach(async () => {
  setLocalVcsCommandObserver(null);
  await Promise.all(opened.splice(0).map((reader) => reader.close()));
});

async function gitFixture() {
  const rootPath = await mkdtemp(path.join(tmpdir(), "blob-batch-"));

  execGit(rootPath, ["init"]);
  execGit(rootPath, ["config", "user.email", "test@example.com"]);
  execGit(rootPath, ["config", "user.name", "Test User"]);
  mkdirSync(path.join(rootPath, "src"));
  writeFileSync(
    path.join(rootPath, "src", "app.ts"),
    "export const app = 1;\n",
  );
  writeFileSync(path.join(rootPath, "empty.ts"), "");
  writeFileSync(path.join(rootPath, "header-like.txt"), headerLike);
  writeFileSync(path.join(rootPath, "large.txt"), large);
  writeFileSync(path.join(rootPath, "binary.bin"), binary);
  execGit(rootPath, ["add", "."]);
  execGit(rootPath, ["commit", "-m", "initial"]);

  return {
    rootPath,
    commit: execGitOutput(rootPath, ["rev-parse", "HEAD"]),
  };
}

const gitReader = (rootPath: string, idleTimeoutMs?: number) =>
  track(
    new BlobBatchReader({
      objectStoreArgs: () => Promise.resolve(["-C", rootPath]),
      idleTimeoutMs,
    }),
  );

describe("blob batch reader", () => {
  it("reads committed text, an empty file and a binary blob", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    recordSpawns();

    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
    await expect(reader.read(commit, "empty.ts")).resolves.toEqual(
      Buffer.alloc(0),
    );
    await expect(reader.read(commit, "binary.bin")).resolves.toEqual(binary);
    expect(batchSpawns()).toBe(1);
  });

  it("frames a body by its length, not by the next newline", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    await expect(reader.read(commit, "header-like.txt")).resolves.toEqual(
      Buffer.from(headerLike),
    );
    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
  });

  it("answers a missing path and an unknown commit without desynchronizing", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    await expect(reader.read(commit, "src/missing.ts")).resolves.toBeNull();
    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
    await expect(reader.read("0".repeat(40), "src/app.ts")).resolves.toBeNull();
    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
  });

  it("resolves fifty concurrent reads in request order", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    await reader.read(commit, "src/app.ts");
    recordSpawns();

    const requests = Array.from({ length: 50 }, (_, index) =>
      index % 5 === 0
        ? "large.txt"
        : index % 5 === 1
          ? "empty.ts"
          : index % 5 === 2
            ? "src/missing.ts"
            : index % 5 === 3
              ? "binary.bin"
              : "src/app.ts",
    );

    const expected = {
      "large.txt": Buffer.from(large),
      "empty.ts": Buffer.alloc(0),
      "src/missing.ts": null,
      "binary.bin": binary,
      "src/app.ts": Buffer.from("export const app = 1;\n"),
    };

    await expect(
      Promise.all(requests.map((file) => reader.read(commit, file))),
    ).resolves.toEqual(requests.map((file) => expected[file]));
    expect(batchSpawns()).toBe(0);
  });

  it("returns null for a path it cannot frame without writing it", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    recordSpawns();

    await expect(reader.read(commit, "src/a\nb.ts")).resolves.toBeNull();
    expect(reader.pid).toBeUndefined();
    expect(batchSpawns()).toBe(0);

    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
    await expect(reader.read(commit, "src/a\nb.ts")).resolves.toBeNull();
    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
  });

  it("rejects in-flight reads when the process is killed and respawns", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    await reader.read(commit, "src/app.ts");
    recordSpawns();
    const killed = reader.pid;
    const inflight = reader.read(commit, "src/app.ts");

    process.kill(killed!, "SIGKILL");
    await expect(inflight).rejects.toThrow("git cat-file --batch");
    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
    expect(batchSpawns()).toBe(1);
    expect(reader.pid).not.toBe(killed);
  });

  it("kills an idle process and respawns on the next read", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath, 20);

    await reader.read(commit, "src/app.ts");
    const retired = reader.processExit();

    recordSpawns();
    await retired;

    expect(reader.pid).toBeUndefined();

    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
    expect(batchSpawns()).toBe(1);
  });

  it("lets a host that forgot to close exit without waiting out the idle timer", async () => {
    const { rootPath, commit } = await gitFixture();

    await expect(
      runWorker("blob-batch-idle-worker.ts", rootPath, commit),
    ).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: "export const app = 1;\n",
    });
  }, 30_000);

  it("keeps a host alive until an awaited close has finished", async () => {
    const { rootPath, commit } = await gitFixture();

    await expect(
      runWorker("blob-batch-close-worker.ts", rootPath, commit),
    ).resolves.toEqual({ code: 0, stderr: "", stdout: "closed\n" });
  }, 30_000);

  it("leaves no process behind when closed while idle", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    await reader.read(commit, "src/app.ts");
    const pid = reader.pid;

    await reader.close();

    expect(alive(pid!)).toBe(false);
    expect(reader.pid).toBeUndefined();
    await reader.close();
    expect(reader.pid).toBeUndefined();
  });

  it("finishes in-flight reads before closing and leaves no process behind", async () => {
    const { rootPath, commit } = await gitFixture();
    const reader = gitReader(rootPath);

    await reader.read(commit, "src/app.ts");
    const pid = reader.pid;

    const inflight = Promise.all([
      reader.read(commit, "large.txt"),
      reader.read(commit, "src/app.ts"),
      reader.read(commit, "binary.bin"),
    ]);

    const closed = reader.close();

    await expect(inflight).resolves.toEqual([
      Buffer.from(large),
      Buffer.from("export const app = 1;\n"),
      binary,
    ]);
    await closed;
    expect(alive(pid!)).toBe(false);
  });

  it("locates a git repository's object store by its root", async () => {
    const { rootPath, commit } = await gitFixture();

    await expect(objectStoreArgs({ rootPath, kind: "git" })).resolves.toEqual([
      "-C",
      rootPath,
    ]);

    const reader = track(createBlobBatchReader({ rootPath, kind: "git" }));

    await expect(reader.read(commit, "src/app.ts")).resolves.toEqual(
      Buffer.from("export const app = 1;\n"),
    );
  });

  it.skipIf(spawnSync("jj", ["--version"]).status !== 0)(
    "locates a jj workspace's backing object store",
    async () => {
      for (const colocate of [true, false]) {
        const rootPath = await mkdtemp(path.join(tmpdir(), "blob-batch-jj-"));

        execFileSync(
          "jj",
          [
            "git",
            "init",
            `--config=git.colocate=${String(colocate)}`,
            rootPath,
          ],
          { stdio: "pipe" },
        );
        execJj(rootPath, ["config", "set", "--repo", "user.name", "Test User"]);
        execJj(rootPath, [
          "config",
          "set",
          "--repo",
          "user.email",
          "test@example.com",
        ]);
        writeFileSync(path.join(rootPath, "app.ts"), "export const app = 1;\n");
        execJj(rootPath, ["commit", "-m", "initial"]);

        const commit = execJjOutput(rootPath, [
          "log",
          "-r",
          "@-",
          "--no-graph",
          "-T",
          "commit_id",
        ]);

        const args = await objectStoreArgs({ rootPath, kind: "jj" });

        expect(args[0]).toBe("--git-dir");
        expect(args[1]).toContain(colocate ? ".git" : ".jj");

        const reader = track(createBlobBatchReader({ rootPath, kind: "jj" }));

        await expect(reader.read(commit, "app.ts")).resolves.toEqual(
          Buffer.from("export const app = 1;\n"),
        );
        recordSpawns();

        await expect(reader.read(commit, "app.ts")).resolves.toEqual(
          Buffer.from("export const app = 1;\n"),
        );
        expect(spawns).toEqual([]);
      }
    },
    30_000,
  );
});

/** Run a fixture in its own process; resolves on `close` (stdout drained). */
async function runWorker(fixture: string, rootPath: string, commit: string) {
  const worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL(`./test-fixtures/${fixture}`, import.meta.url)),
      rootPath,
      commit,
      "src/app.ts",
    ],
    {
      cwd: path.resolve(fileURLToPath(new URL("../../..", import.meta.url))),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const closed = new Promise<number | null>((resolve) => {
    worker.once("close", (code) => resolve(code));
  });

  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), 10_000);
  });

  const code = await Promise.race([closed, expired]);

  clearTimeout(timer);

  if (code === "waiting") worker.kill("SIGKILL");

  return { code, stderr, stdout };
}

function execGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function execGitOutput(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function execJj(cwd: string, args: string[]) {
  execFileSync("jj", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function execJjOutput(cwd: string, args: string[]) {
  return execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
