// Run from apps/review-desktop after installing workspace dependencies:
// TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx scripts/repro-folder-collision.mjs
// This is an investigation harness, not a regression test for an implemented fix.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Event } from "../code-oss/src/vs/base/common/event.ts";
import { URI } from "../code-oss/src/vs/base/common/uri.ts";
import {
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  createFileSystemProviderError,
} from "../code-oss/src/vs/platform/files/common/files.ts";
import { FileService } from "../code-oss/src/vs/platform/files/common/fileService.ts";
import { NullLogService } from "../code-oss/src/vs/platform/log/common/log.ts";

// Keep the real FileService and real filesystem, adapting only the provider
// interface to avoid native Electron/watch dependencies in this CLI harness.
async function operation(action) {
  try {
    return await action();
  } catch (error) {
    const codes = {
      ENOENT: FileSystemProviderErrorCode.FileNotFound,
      ENOTDIR: FileSystemProviderErrorCode.FileNotADirectory,
      EEXIST: FileSystemProviderErrorCode.FileExists,
    };

    throw createFileSystemProviderError(
      error,
      codes[error.code] ?? FileSystemProviderErrorCode.Unknown,
    );
  }
}

const provider = {
  capabilities: FileSystemProviderCapabilities.PathCaseSensitive,
  onDidChangeCapabilities: Event.None,
  onDidChangeFile: Event.None,
  async stat(resource) {
    const stat = await operation(() => fs.stat(resource.fsPath));

    return {
      type: stat.isDirectory() ? FileType.Directory : FileType.File,
      ctime: stat.ctimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  },
  mkdir: (resource) => operation(() => fs.mkdir(resource.fsPath)),
  async readdir(resource) {
    const entries = await operation(() =>
      fs.readdir(resource.fsPath, { withFileTypes: true }),
    );

    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? FileType.Directory : FileType.File,
    ]);
  },
};

const root = await fs.mkdtemp(join(tmpdir(), "review-folder-collision-"));

const service = new FileService(new NullLogService());

const registration = service.registerProvider("file", provider);

let creates = 0;

const listener = service.onDidRunOperation(() => creates++);

try {
  const target = join(root, "folder with spaces");
  const content = "Existing user file: keep these bytes.\n";
  await fs.writeFile(target, content);
  await assert.rejects(
    service.createFolder(URI.file(target)),
    /already exists but is not a directory/,
  );
  assert.equal(await fs.readFile(target, "utf8"), content);
  assert.equal(creates, 0);
  console.log(
    "Reproduced the reported FileService collision; file bytes preserved.",
  );

  await assert.rejects(service.createFolder(URI.file(join(target, "child"))));
  assert.equal(await fs.readFile(target, "utf8"), content);
  assert.equal(creates, 0);
  console.log(
    "An ancestor file also prevents folder creation without losing data.",
  );

  // Simulate explicit user recovery only inside this disposable fixture.
  const backup = join(root, "preserved-file");
  await fs.rename(target, backup);
  const created = await service.createFolder(URI.file(join(target, "child")));
  assert.equal(created.isDirectory, true);
  assert.equal(await fs.readFile(backup, "utf8"), content);
  await service.createFolder(URI.file(join(target, "child")));
  assert.equal((await fs.stat(join(target, "child"))).isDirectory(), true);
  console.log(
    "Creation recovers after explicit fixture rename; existing directories are accepted.",
  );
} finally {
  listener.dispose();
  registration.dispose();
  service.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
