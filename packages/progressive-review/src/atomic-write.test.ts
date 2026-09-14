import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  writeFileAtomic,
  writeFileAtomicAsync,
  writePrivateJsonAtomic,
} from "./atomic-write";

describe("writeFileAtomic", () => {
  it("writes contents and overwrites an existing file without leaving temp files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const target = path.join(dir, "review.mdx");

    try {
      writeFileSync(target, "old contents", "utf8");

      writeFileAtomic(target, "new contents", "utf8");

      expect(readFileSync(target, "utf8")).toBe("new contents");
      // The temp sibling is renamed over the target, so nothing else is left
      // behind in the directory.
      expect(readdirSync(dir)).toEqual(["review.mdx"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the target directory when it does not exist", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const target = path.join(dir, "nested", "deep", "state.json");

    try {
      writeFileAtomic(target, '{"ok":true}\n');
      expect(readFileSync(target, "utf8")).toBe('{"ok":true}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing file permissions when replacing contents", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const target = path.join(dir, "state.json");

    try {
      writeFileSync(target, "old", "utf8");
      chmodSync(target, 0o640);

      writeFileAtomic(target, "new", "utf8");

      expect(statSync(target).mode & 0o777).toBe(0o640);
      expect(readFileSync(target, "utf8")).toBe("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses a sibling temp file and cleans it after interruption before rename", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const target = path.join(dir, "review.mdx");
    let tmpfile: string | undefined;

    try {
      writeFileSync(target, "old contents", "utf8");

      expect(() =>
        writeFileAtomic(target, "new contents", "utf8", {
          tmpfileCreated: (created) => {
            tmpfile = created;
            throw new Error("simulated interruption");
          },
        }),
      ).toThrow("simulated interruption");

      expect(realpathSync(path.dirname(tmpfile ?? ""))).toBe(realpathSync(dir));
      expect(readFileSync(target, "utf8")).toBe("old contents");
      expect(readdirSync(dir)).toEqual(["review.mdx"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writePrivateJsonAtomic", () => {
  it("writes pretty JSON with owner-only file and directory modes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const target = path.join(dir, "nested", "auth.json");

    try {
      await writePrivateJsonAtomic(target, { token: "secret", n: 1 });

      expect(readFileSync(target, "utf8")).toBe(
        '{\n  "token": "secret",\n  "n": 1\n}\n',
      );
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(["sync", "async"])("%s atomic replacement", (kind) => {
  async function write(
    target: string,
    contents: string | Uint8Array,
    options = {},
  ) {
    if (kind === "sync") writeFileAtomic(target, contents, "utf8", options);
    else await writeFileAtomicAsync(target, contents, options);
  }

  it("updates a symlink target while retaining its permissions and ownership", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

    try {
      const target = path.join(dir, "target");
      const link = path.join(dir, "link");
      writeFileSync(target, "old", { mode: 0o640 });
      symlinkSync("target", link);
      const before = statSync(target);
      await write(link, new Uint8Array([0, 255, 65]));
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target)).toEqual(Buffer.from([0, 255, 65]));
      const after = statSync(target);
      expect([after.mode, after.uid, after.gid]).toEqual([
        before.mode,
        before.uid,
        before.gid,
      ]);
      expect(readdirSync(dir).sort()).toEqual(["link", "target"]);
      await write(link, "private", { mode: 0o600 });
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, "utf8")).toBe("private");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans up after a failed rename without replacing the destination directory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

    try {
      const target = path.join(dir, "state");
      mkdirSync(target);
      writeFileSync(path.join(target, "existing"), "old");
      await expect(write(target, "new")).rejects.toThrow(
        /EISDIR|ENOTEMPTY|EEXIST/,
      );
      expect(readFileSync(path.join(target, "existing"), "utf8")).toBe("old");
      expect(readdirSync(dir)).toEqual(["state"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the callback error even when temporary-file cleanup fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

    try {
      const target = path.join(dir, "state");
      writeFileSync(target, "old");
      const failure = new Error("original failure");
      await expect(
        write(target, "new", {
          tmpfileCreated: (tmp: string) => {
            unlinkSync(tmp);
            mkdirSync(tmp);
            writeFileSync(path.join(tmp, "obstruction"), "leave intact");
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(readFileSync(target, "utf8")).toBe("old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates nested files with explicit permissions and replaces them with empty contents", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

    try {
      const target = path.join(dir, "nested", "state");
      await write(target, "hello", { mode: 0o600 });
      expect(readFileSync(target, "utf8")).toBe("hello");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      await write(target, "");
      expect(readFileSync(target).length).toBe(0);
      expect(readdirSync(path.dirname(target))).toEqual(["state"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("asynchronous atomic ordering", () => {
  it("waits for a successful callback before publishing contents", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();

    try {
      const target = path.join(dir, "state");
      writeFileSync(target, "old");

      const pending = writeFileAtomicAsync(target, "new", {
        tmpfileCreated: async () => {
          entered.resolve();
          await release.promise;
        },
      });

      await entered.promise;
      expect(readFileSync(target, "utf8")).toBe("old");
      release.resolve();
      await pending;
      expect(readFileSync(target, "utf8")).toBe("new");
      expect(readdirSync(dir)).toEqual(["state"]);
    } finally {
      release.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("awaits callbacks and serializes writes through a callback failure", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const events: string[] = [];

    try {
      const target = path.join(dir, "state");
      writeFileSync(target, "old");

      const first = writeFileAtomicAsync(target, "first", {
        tmpfileCreated: async () => {
          events.push("first");
          entered.resolve();
          await release.promise;
          throw new Error("callback failed");
        },
      });

      const rejected = first.catch((error: Error) => error);
      await entered.promise;

      const second = writeFileAtomicAsync(target, "second", {
        tmpfileCreated: () => {
          expect(events).toEqual(["first", "released"]);
          expect(readFileSync(target, "utf8")).toBe("old");
          events.push("second");
        },
      });

      // A different destination must remain writable while the first callback waits.
      const independent = path.join(dir, "independent");
      await writeFileAtomicAsync(independent, "ready");
      expect(readFileSync(independent, "utf8")).toBe("ready");
      expect(events).toEqual(["first"]);
      expect(readFileSync(target, "utf8")).toBe("old");
      events.push("released");
      release.resolve();
      expect(await rejected).toEqual(new Error("callback failed"));
      await second;
      expect(readFileSync(target, "utf8")).toBe("second");
      expect(readdirSync(dir).sort()).toEqual(["independent", "state"]);
      await writeFileAtomicAsync(target, "third");
      expect(readFileSync(target, "utf8")).toBe("third");
    } finally {
      release.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each([
  { name: "Uint8Array", create: () => new Uint8Array([65]) },
  { name: "Buffer", create: () => Buffer.from("A") },
])("$name input snapshots", ({ create }) => {
  it("retains the supplied bytes when a synchronous callback mutates the input", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

    try {
      const target = path.join(dir, "state");
      const bytes = create();
      writeFileAtomic(target, bytes, undefined, {
        tmpfileCreated: () => {
          bytes[0] = 66;
        },
      });
      expect(readFileSync(target, "utf8")).toBe("A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retains the supplied bytes when the caller immediately reuses the input", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

    try {
      const target = path.join(dir, "state");
      const bytes = create();
      const pending = writeFileAtomicAsync(target, bytes);
      bytes[0] = 66;
      await pending;
      expect(readFileSync(target, "utf8")).toBe("A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retains queued bytes when the caller reuses the input before an earlier write completes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      const target = path.join(dir, "state");

      const first = writeFileAtomicAsync(target, "first", {
        tmpfileCreated: async () => {
          entered.resolve();
          await release.promise;
        },
      });

      await entered.promise;
      const bytes = create();
      const pending = writeFileAtomicAsync(target, bytes);
      bytes[0] = 66;
      release.resolve();
      await Promise.all([first, pending]);
      expect(readFileSync(target, "utf8")).toBe("A");
      expect(readdirSync(dir)).toEqual(["state"]);
    } finally {
      release.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
