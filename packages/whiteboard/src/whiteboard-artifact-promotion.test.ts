import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { promoteWhiteboardArtifactFiles } from "./whiteboard-artifact-promotion";
import { parseStoredWhiteboardRecord } from "./whiteboard-home";
import {
  cleanupTempDirs,
  storedWhiteboardFixture,
} from "./whiteboard-test-utils";

let root: string;

afterEach(cleanupTempDirs);

async function fixture() {
  const staged = await storedWhiteboardFixture();
  const whiteboardDir = staged.whiteboardDir;
  root = path.dirname(whiteboardDir);
  const candidateDir = path.join(root, "candidate");
  await cp(whiteboardDir, candidateDir, { recursive: true });
  await writeFile(path.join(candidateDir, ".git", "HEAD"), "new-head");
  await writeFile(
    path.join(candidateDir, ".bundle", "document"),
    "new-document",
  );

  return {
    whiteboardDir,
    candidateDir,
    record: {
      ...parseStoredWhiteboardRecord(staged.record),
      presentedDocumentRevision: "d".repeat(40),
    },
  };
}

it("stages every replacement before touching live files", async () => {
  const input = await fixture();
  await rm(path.join(input.candidateDir, ".git"), { recursive: true });

  const originalInode = (await stat(path.join(input.whiteboardDir, ".git")))
    .ino;

  await expect(promoteWhiteboardArtifactFiles(input)).rejects.toThrow("ENOENT");
  expect((await stat(path.join(input.whiteboardDir, ".git"))).ino).toBe(
    originalInode,
  );
  expect(
    await readFile(path.join(input.whiteboardDir, ".git", "HEAD"), "utf8"),
  ).toBe("old-head");
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

// Moving a directory to a new parent needs write permission on the directory
// itself, so a read-only .git fails the second replacement — after .bundle has
// already been swapped in — and drives the rollback.
async function promoteWithUnmovableGit(
  input: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  const pinned = path.join(input.whiteboardDir, ".git");
  await chmod(pinned, 0o500);

  try {
    await expect(promoteWhiteboardArtifactFiles(input)).rejects.toMatchObject({
      code: "EACCES",
    });
  } finally {
    await chmod(pinned, 0o700);
  }
}

it("restores a replaced artifact by rename when a later replacement fails", async (context) => {
  // Root ignores the permission bits this case relies on.
  if (process.getuid?.() === 0) context.skip();
  const input = await fixture();
  await promoteWithUnmovableGit(input);
  expect(
    await readFile(
      path.join(input.whiteboardDir, ".bundle", "document"),
      "utf8",
    ),
  ).toBe("old-document");
  expect(
    await readFile(path.join(input.whiteboardDir, ".git", "HEAD"), "utf8"),
  ).toBe("old-head");
  expect(
    JSON.parse(
      await readFile(path.join(input.whiteboardDir, "review.json"), "utf8"),
    ).presentedDocumentRevision,
  ).toBe("c".repeat(40));
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

it("removes a replacement that had no original when a later replacement fails", async (context) => {
  if (process.getuid?.() === 0) context.skip();
  const input = await fixture();
  await rm(path.join(input.whiteboardDir, ".bundle"), { recursive: true });
  await promoteWithUnmovableGit(input);
  expect(existsSync(path.join(input.whiteboardDir, ".bundle"))).toBe(false);
  expect(
    await readFile(path.join(input.whiteboardDir, ".git", "HEAD"), "utf8"),
  ).toBe("old-head");
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});

it("promotes fully prepared files and removes temporary state", async () => {
  const input = await fixture();
  await promoteWhiteboardArtifactFiles(input);
  expect(
    await readFile(path.join(input.whiteboardDir, ".git", "HEAD"), "utf8"),
  ).toBe("new-head");
  expect(
    await readFile(
      path.join(input.whiteboardDir, ".bundle", "document"),
      "utf8",
    ),
  ).toBe("new-document");
  expect(
    JSON.parse(
      await readFile(path.join(input.whiteboardDir, "review.json"), "utf8"),
    ),
  ).toEqual(input.record);
  expect((await readdir(root)).sort()).toEqual(["candidate", "review"]);
});
