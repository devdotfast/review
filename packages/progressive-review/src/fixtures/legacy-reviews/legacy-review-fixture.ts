import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

const execFilePromise = promisify(execFile);

export interface LegacyReviewFixtureMetadata {
  name: string;
  sourceUuid: string;
  schemaVersion: 2 | 3 | 4;
  hasMap: boolean;
  baseCommit: string;
  sourceCommit: string;
  sourceRepository: "devdotfast/review" | "tutorial-sample";
}

export const LEGACY_REVIEW_FIXTURES_ROOT = path.resolve(import.meta.dirname);

export async function listLegacyReviewFixtures(): Promise<
  LegacyReviewFixtureMetadata[]
> {
  const names = (await readdir(LEGACY_REVIEW_FIXTURES_ROOT))
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => entry.slice(0, -4))
    .sort();
  return Promise.all(names.map(readMetadata));
}

async function readMetadata(
  name: string,
): Promise<LegacyReviewFixtureMetadata> {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error("Invalid legacy fixture name.");
  const metadata: LegacyReviewFixtureMetadata = JSON.parse(
    await readFile(
      path.join(LEGACY_REVIEW_FIXTURES_ROOT, `${name}.json`),
      "utf8",
    ),
  );
  if (metadata.name !== name || !/^[0-9a-f-]{36}$/.test(metadata.sourceUuid))
    throw new Error("Invalid legacy fixture metadata.");
  return metadata;
}

export async function extractLegacyReviewFixture(
  name: string,
  options: { worktreePath?: string } = {},
): Promise<{
  home: string;
  dir: string;
  uuid: string;
  metadata: LegacyReviewFixtureMetadata;
  originalRecord: JsonObject;
}> {
  const metadata = await readMetadata(name);
  const home = await mkdtemp(path.join(os.tmpdir(), `legacy-${name}-`));
  try {
    const dir = path.join(home, "reviews", metadata.sourceUuid);
    await mkdir(dir, { recursive: true });
    await execFilePromise("tar", [
      "-xzf",
      path.join(LEGACY_REVIEW_FIXTURES_ROOT, `${name}.tgz`),
      "-C",
      dir,
    ]);
    const worktreePath = options.worktreePath ?? path.join(home, "worktree");
    await mkdir(worktreePath, { recursive: true });
    const recordPath = path.join(dir, "review.json");
    const original = jsonObject(
      parseJsonText(await readFile(recordPath, "utf8")),
    );
    if (!original) throw new Error("Legacy fixture record is not an object.");
    const originalRecord = { ...original, worktreePath };
    await writeFile(recordPath, `${JSON.stringify(originalRecord, null, 2)}\n`);
    return { home, dir, uuid: metadata.sourceUuid, metadata, originalRecord };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

export async function snapshotReviewTree(
  dir: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      if (entry.name.endsWith(".lock") || entry.name === ".mutation-lock")
        continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else
        files[name] = createHash("sha256")
          .update(await readFile(path.join(dir, name)))
          .digest("hex");
    }
  }
  await visit("");
  return files;
}

export async function readLegacyReviewGolden(
  name: string,
  kind: "record" | "document" | "map",
): Promise<JsonValue> {
  await readMetadata(name);
  return parseJsonText(
    await readFile(
      path.join(LEGACY_REVIEW_FIXTURES_ROOT, `${name}.expected-${kind}.json`),
      "utf8",
    ),
  );
}

export function normalizeMigratedRecord(record: JsonObject): JsonObject {
  return {
    ...record,
    worktreePath: "<worktree>",
    presentedDocumentRevision: record.presentedDocumentRevision
      ? "<document-revision>"
      : null,
    presentedSoftwareMapRevision: record.presentedSoftwareMapRevision
      ? "<map-revision>"
      : null,
  };
}
