import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic-write";

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
