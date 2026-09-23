import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { errorMessage, writePrivateJsonAtomic } from "@dev.fast/trace-core";
import {
  type JsonObject,
  WHITEBOARD_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import {
  authoringSessionKey,
  parseAuthoringSessionKey,
} from "./agent-session-ref";
import { isMissingFileError } from "./fs-utils";
import {
  type WhiteboardSoftwareMapBundle,
  bundleWhiteboardSoftwareMap,
  readWhiteboardSoftwareMapBundle,
  writeWhiteboardSoftwareMapBundle,
} from "./software-map-bundle";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";
import { promoteWhiteboardArtifactFiles } from "./whiteboard-artifact-promotion";
import {
  bundleWhiteboardDocument,
  readWhiteboardDocumentBundle,
  writeWhiteboardDocumentBundle,
} from "./whiteboard-bundle";
import { isAuthoringInput } from "./whiteboard-derived-paths";
import { removeLegacyWhiteboardCheckouts } from "./whiteboard-head-checkout";
import {
  DISABLED_WHITEBOARD_SOURCE_SESSION,
  type StoredWhiteboardRecord,
  allowsAbsentSoftwareMap,
  materializeWhiteboardRevision,
  parseAnyStoredWhiteboardRecord,
  parseStoredWhiteboardRecord,
  sealWhiteboardCandidate,
} from "./whiteboard-home";
import { withWhiteboardMutationLock } from "./whiteboard-mutation-lock";
import { evaluateSealedWhiteboardDocument } from "./whiteboard-sealed-document";
import { whiteboardSourcePins } from "./whiteboard-source-pins";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredWhiteboardMigrationResult {
  failedWhiteboardUuids?: string[];
  documents: number;
  droppedLegacyPeekWhiteboards: number;
  droppedWhiteboards: number;
  legacyCheckoutsRemoved: number;
}

export interface StoredWhiteboardMigrationOutcome {
  record: StoredWhiteboardRecord;
  migrated: boolean;
}

interface StoredWhiteboardMigrationInput {
  whiteboardDir: string;
  log?: (message: string) => void;
}

/** One review: record normalization and sealed artifact conversion. Shared by
 * the CLI sweep and the store loader. Repo-level cleanup (legacy checkouts,
 * `repos/`) stays in the sweep. */
export async function migrateStoredWhiteboard(
  input: StoredWhiteboardMigrationInput,
): Promise<StoredWhiteboardMigrationOutcome> {
  return withWhiteboardMutationLock(input.whiteboardDir, () =>
    migrateStoredWhiteboardLocked(input),
  );
}

async function migrateStoredWhiteboardLocked(
  input: StoredWhiteboardMigrationInput,
): Promise<StoredWhiteboardMigrationOutcome> {
  const value = jsonObject(
    parseJsonText(
      await readFile(path.join(input.whiteboardDir, "review.json"), "utf8"),
    ),
  );

  const schemaVersion = value?.schemaVersion;

  if (
    !value ||
    ![2, 3, 4, WHITEBOARD_SCHEMA_VERSION].includes(Number(schemaVersion))
  ) {
    throw new Error("Unsupported Review schema; the record was preserved.");
  }

  const validatedRecord = parseAnyStoredWhiteboardRecord(value);

  const migratedRecord =
    schemaVersion === 3 || schemaVersion === 2
      ? parseStoredWhiteboardRecord({
          ...validatedRecord,
          sourceSession: DISABLED_WHITEBOARD_SOURCE_SESSION,
        })
      : validatedRecord;

  if (migratedRecord.uuid !== path.basename(input.whiteboardDir))
    throw new Error("review.json UUID does not match its directory");

  const migrated =
    schemaVersion !== WHITEBOARD_SCHEMA_VERSION &&
    (await regeneratePresentedArtifacts({
      whiteboardDir: input.whiteboardDir,
      review: migratedRecord,
      original: value,
      allowAbsentMap: allowsAbsentSoftwareMap({
        schemaVersion: Number(schemaVersion),
      }),
      log: input.log,
      finalizeSource: async (record) =>
        schemaVersion === 2 || schemaVersion === 3
          ? migrateLegacyWhiteboardSourceSession(record, value, input.log)
          : record,
    }));

  const record = parseStoredWhiteboardRecord(
    parseJsonText(
      await readFile(path.join(input.whiteboardDir, "review.json"), "utf8"),
    ),
  );

  return { record, migrated };
}

export async function migrateStoredWhiteboardData(input: {
  whiteboardHome: string;
  log?: (message: string) => void;
  onBlocker?: (message: string) => void;
}): Promise<StoredWhiteboardMigrationResult> {
  await rm(path.join(input.whiteboardHome, "repos"), {
    recursive: true,
    force: true,
  });

  const total: StoredWhiteboardMigrationResult = {
    failedWhiteboardUuids: [],
    documents: 0,
    droppedLegacyPeekWhiteboards: 0,
    droppedWhiteboards: 0,
    legacyCheckoutsRemoved: 0,
  };

  const reviewsRoot = path.join(input.whiteboardHome, "reviews");
  const cleanedLegacyRoots = new Set<string>();
  let entries: import("node:fs").Dirent[];

  try {
    entries = await readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return total;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    const whiteboardDir = path.join(reviewsRoot, entry.name);

    try {
      const outcome = await migrateStoredWhiteboard({
        whiteboardDir,
        log: input.log,
      });

      const worktreePath = outcome.record.worktreePath;

      if (!cleanedLegacyRoots.has(worktreePath)) {
        cleanedLegacyRoots.add(worktreePath);
        total.legacyCheckoutsRemoved += await removeLegacyWhiteboardCheckouts({
          rootPath: worktreePath,
          onBlocker: input.onBlocker,
        });
      }

      total.documents += 1;
    } catch (error) {
      total.failedWhiteboardUuids?.push(entry.name);
      const message = `${whiteboardDir}: current artifact migration failed: ${errorMessage(error)} Review preserved; retry review migrate apply after resolving the blocker.`;
      input.onBlocker?.(message);
      input.log?.(message);
    }
  }

  return total;
}

/** Schema 2 and 3 records named the authoring session `agentSession`. It
 * becomes the source session as-is; a record without a usable session keeps
 * the disabled marker. */
function migrateLegacyWhiteboardSourceSession(
  record: StoredWhiteboardRecord,
  original: JsonObject,
  log?: (message: string) => void,
): StoredWhiteboardRecord {
  const source = parseAuthoringSessionKey(jsonString(original.agentSession));

  if (!source) {
    log?.(
      `Review ${record.uuid} has no usable authoring session; the Review was preserved.`,
    );

    return { ...record, sourceSession: DISABLED_WHITEBOARD_SOURCE_SESSION };
  }

  const sourceSession = authoringSessionKey(source);

  if (record.agentSessions?.[sourceSession])
    return { ...record, sourceSession };
  const now = new Date().toISOString();

  return {
    ...record,
    sourceSession,
    agentSessions: {
      ...record.agentSessions,
      [sourceSession]: { firstSeenAt: now, lastSeenAt: now, roles: ["author"] },
    },
  };
}

async function regeneratePresentedArtifacts(input: {
  whiteboardDir: string;
  review: ReturnType<typeof parseAnyStoredWhiteboardRecord>;
  original: JsonObject;
  allowAbsentMap: boolean;
  log?: (message: string) => void;
  finalizeSource: (
    record: StoredWhiteboardRecord,
  ) => Promise<StoredWhiteboardRecord>;
}): Promise<boolean> {
  const staging = await mkdtemp(
    path.join(tmpdir(), "review-artifact-migration-"),
  );

  const documentDir = path.join(staging, "document");
  const mapDir = path.join(staging, "map");

  try {
    let documentBundle: ReturnType<typeof bundleWhiteboardDocument> | null =
      null;

    let evaluatedDocument:
      | Awaited<ReturnType<typeof evaluateSealedWhiteboardDocument>>
      | undefined;

    let documentRecord: StoredWhiteboardRecord | undefined;
    let mapRecord: StoredWhiteboardRecord | undefined;
    let mapBundle: WhiteboardSoftwareMapBundle | null = null;
    let mapRevision = input.review.presentedSoftwareMapRevision;
    const documentRevision = input.review.presentedDocumentRevision;

    if (documentRevision) {
      await materializeWhiteboardRevision(
        input.whiteboardDir,
        documentRevision,
        documentDir,
      );
      documentRecord = parseAnyStoredWhiteboardRecord(
        parseJsonText(
          await readFile(path.join(documentDir, "review.json"), "utf8"),
        ),
      );

      if (!(await readWhiteboardDocumentBundle(documentDir, "/"))) {
        evaluatedDocument = await evaluateSealedWhiteboardDocument(
          documentDir,
          input.log,
        );
        documentBundle = bundleWhiteboardDocument(evaluatedDocument.document);
      }
    }

    if (mapRevision) {
      await materializeWhiteboardRevision(
        input.whiteboardDir,
        mapRevision,
        mapDir,
      );
      mapRecord = parseAnyStoredWhiteboardRecord(
        parseJsonText(await readFile(path.join(mapDir, "review.json"), "utf8")),
      );

      if (!(await readWhiteboardSoftwareMapBundle(mapDir))) {
        mapBundle = await legacySoftwareMapBundle(mapDir);

        if (!mapBundle) {
          if (!input.allowAbsentMap)
            throw new Error("The presented software map is missing.");

          const evaluated =
            mapRevision === documentRevision && evaluatedDocument
              ? evaluatedDocument
              : await evaluateSealedWhiteboardDocument(mapDir, input.log);

          if (evaluated.legacySoftwareMap) {
            const sealed = mapRecord;

            if (!sealed.sourceCommit)
              throw new Error(
                "The embedded software map has no sealed source commit.",
              );
            mapBundle = bundleWhiteboardSoftwareMap({
              ...evaluated.legacySoftwareMap,
              baseCommit: sealed.baseCommit,
              headCommit: sealed.sourceCommit,
            });
          } else {
            mapRevision = null;
          }
        }
      }
    }

    // Source migration and schema normalization must not race a lifecycle or pin change.
    return await withWhiteboardMutationLock(input.whiteboardDir, async () => {
      const recordPath = path.join(input.whiteboardDir, "review.json");
      const currentText = await readFile(recordPath, "utf8");

      if (
        JSON.stringify(parseJsonText(currentText)) !==
        JSON.stringify(input.original)
      ) {
        throw new Error(
          "Review changed while preparing migration; rerun review migrate apply.",
        );
      }

      if (!documentBundle && !mapBundle) {
        if (
          input.original.schemaVersion !== WHITEBOARD_SCHEMA_VERSION ||
          mapRevision !== input.review.presentedSoftwareMapRevision
        ) {
          await writePrivateJsonAtomic(
            recordPath,
            await input.finalizeSource({
              ...input.review,
              presentedSoftwareMapRevision: mapRevision,
            }),
          );
          input.log?.("Migrated Review " + input.review.uuid + " to schema 5.");

          return true;
        }

        return false;
      }

      const candidateDir = path.join(staging, "candidate");
      await cp(
        path.join(input.whiteboardDir, ".git"),
        path.join(candidateDir, ".git"),
        {
          recursive: true,
        },
      );
      await cp(
        path.join(documentRevision ? documentDir : mapDir, ".bundle"),
        path.join(candidateDir, ".bundle"),
        { recursive: true },
      );

      if (!mapBundle) {
        await rm(path.join(candidateDir, ".bundle/software-map"), {
          recursive: true,
          force: true,
        });

        if (mapRevision) {
          await cp(
            path.join(mapDir, ".bundle/software-map"),
            path.join(candidateDir, ".bundle/software-map"),
            { recursive: true },
          );
        }
      }

      const candidateRecordPath = path.join(candidateDir, "review.json");
      let completed = false;
      const newRevisions: string[] = [];

      try {
        if (documentBundle) {
          await rm(path.join(candidateDir, ".bundle/document"), {
            recursive: true,
            force: true,
          });
          await rm(path.join(candidateDir, ".bundle/review-document.js"), {
            force: true,
          });
          await rm(path.join(candidateDir, ".bundle/manifest.json"), {
            force: true,
          });
          await writeWhiteboardDocumentBundle(candidateDir, documentBundle);
        }

        if (mapBundle) {
          await rm(path.join(candidateDir, ".bundle/software-map"), {
            recursive: true,
            force: true,
          });
          await writeWhiteboardSoftwareMapBundle(candidateDir, mapBundle);
        }

        let next = {
          ...input.review,
          presentedSoftwareMapRevision: mapRevision,
        };

        if (mapBundle) {
          await replaceCandidateSources(candidateDir, mapDir);
          await writePrivateJsonAtomic(candidateRecordPath, {
            ...next,
            ...whiteboardSourcePins(mapRecord!),
          });
          mapRevision = await sealWhiteboardCandidate(
            candidateDir,
            "Migrate current Review software map to JSON",
          );
          newRevisions.push(mapRevision);
          next = { ...next, presentedSoftwareMapRevision: mapRevision };
        }

        if (documentBundle) {
          await replaceCandidateSources(candidateDir, documentDir);
          await writePrivateJsonAtomic(candidateRecordPath, {
            ...next,
            ...whiteboardSourcePins(documentRecord!),
          });

          const revision = await sealWhiteboardCandidate(
            candidateDir,
            "Migrate current Review document to JSON",
          );

          newRevisions.push(revision);
          next = { ...next, presentedDocumentRevision: revision };
        }

        for (const revision of newRevisions) {
          await materializeWhiteboardRevision(
            candidateDir,
            revision,
            path.join(input.whiteboardDir, ".build", revision),
          );
        }

        next = await input.finalizeSource(next);
        await promoteWhiteboardArtifactFiles({
          whiteboardDir: input.whiteboardDir,
          candidateDir,
          record: next,
        });
        completed = true;
        input.log?.(
          "Migrated current presentation for Review " +
            input.review.uuid +
            " to JSON.",
        );

        return true;
      } finally {
        if (!completed) {
          for (const revision of newRevisions)
            await rm(path.join(input.whiteboardDir, ".build", revision), {
              recursive: true,
              force: true,
            });
        }
      }
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function replaceCandidateSources(
  candidateDir: string,
  sourceDir: string,
): Promise<void> {
  for (const name of await readdir(candidateDir)) {
    if (name !== ".git" && name !== ".bundle") {
      await rm(path.join(candidateDir, name), { recursive: true, force: true });
    }
  }

  await cp(sourceDir, candidateDir, {
    recursive: true,
    filter: (source) =>
      isAuthoringInput(
        path.relative(sourceDir, source).split(path.sep)[0] ?? "",
      ),
  });
}

export async function legacySoftwareMapBundle(
  legacyBuildDir: string,
): Promise<WhiteboardSoftwareMapBundle | null> {
  const mapDir = path.join(legacyBuildDir, ".bundle", "software-map");
  let manifestValue: JsonObject | undefined;

  try {
    manifestValue = jsonObject(
      parseJsonText(await readFile(path.join(mapDir, "manifest.json"), "utf8")),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      try {
        await readdir(mapDir);
      } catch (directoryError) {
        if (isMissingFileError(directoryError)) return null;
        throw directoryError;
      }

      throw new Error("The presented software map has no manifest.");
    }

    throw error;
  }

  const headCommit = jsonString(manifestValue?.headCommit);
  const baseCommit = jsonString(manifestValue?.baseCommit);

  if (
    manifestValue?.version !== 1 ||
    !headCommit ||
    !baseCommit ||
    !/^[0-9a-f]{40}$/i.test(headCommit) ||
    !/^[0-9a-f]{40}$/i.test(baseCommit)
  ) {
    throw new Error(
      "The presented software-map manifest is invalid or unsupported.",
    );
  }

  const load = async (
    file: string,
  ): Promise<NormalizedSoftwareModel | null> => {
    const url = pathToFileURL(path.join(mapDir, file));
    url.searchParams.set("t", `${Date.now()}-${Math.random()}`);

    try {
      // SAFETY: an imported legacy map module has no static TypeScript shape;
      // isNormalizedSoftwareModel validates its default export before use.
      const module = (await import(url.href)) as { default?: unknown };

      return isNormalizedSoftwareModel(module.default) ? module.default : null;
    } catch {
      return null;
    }
  };

  const [head, base] = await Promise.all([
    load("head-map.js"),
    load("base-map.js"),
  ]);

  if (!head || !base)
    throw new Error(
      "The presented software map could not be converted; its sealed head or base bundle is invalid.",
    );

  return bundleWhiteboardSoftwareMap({ head, base, headCommit, baseCommit });
}
