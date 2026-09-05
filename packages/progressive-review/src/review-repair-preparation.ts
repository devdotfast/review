import { cp, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readNote, remoteNotesRef } from "@dev.fast/local-vcs";
import {
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { errorMessage as message } from "./error-message";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  type StoredReviewRecord,
  materializeReviewRevision,
  parseStoredReviewRecordForRecovery,
  sealReviewCandidate,
} from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { prepareReviewDocumentBundle } from "./review-publication-preparation";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import {
  type ReviewRepairReadyRequest,
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "./review-repair-state";
import { SOFTWARE_MAP_NOTES_REF } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import {
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { checkSoftwareMapSource } from "./software-map-health";
import { legacySoftwareMapBundle } from "./stored-review-migration";

export type PreparedReviewRepair =
  | { kind: "noop"; review: StoredReviewRecord }
  | {
      kind: "prepared";
      request: ReviewRepairReadyRequest;
      review: StoredReviewRecord;
      cleanup: () => Promise<void>;
    };

/** Only the isolated snapshot is writable. Promotion belongs to /repair-ready. */
export async function prepareReviewRepair(input: {
  reviewDir: string;
  warning?: (message: string) => void;
}): Promise<PreparedReviewRepair> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "review-repair-"));
  const stagingDir = path.join(temporaryRoot, "candidate");
  const cleanup = () => rm(temporaryRoot, { recursive: true, force: true });
  try {
    const snapshot = await withReviewMutationLock(input.reviewDir, async () => {
      await assertIsolatedRepairInternals(input.reviewDir);
      await assertNoActiveReviewAgentWrites(input.reviewDir);
      const expectedRecord = await readFile(
        path.join(input.reviewDir, "review.json"),
        "utf8",
      );
      const review = parseStoredReviewRecordForRecovery(
        parseJsonText(expectedRecord),
      );
      if (review.uuid !== path.basename(input.reviewDir))
        throw new Error("Review UUID does not match its storage directory.");
      if (!review.presentedDocumentRevision)
        throw new Error(
          "This Review has no current presentation. Run review publish instead.",
        );
      const expectedFingerprint = await fingerprintReviewRepairInputs(
        input.reviewDir,
      );
      await cp(input.reviewDir, stagingDir, {
        recursive: true,
        filter: (source) => {
          const first = path
            .relative(input.reviewDir, source)
            .split(path.sep)[0];
          return (
            ![".build", ".native-agent"].includes(first) &&
            !/^review\.db(?:-|$)/.test(first) &&
            !first.endsWith(".lock")
          );
        },
      });
      await assertIsolatedRepairInternals(stagingDir);
      if (
        (await fingerprintReviewRepairInputs(input.reviewDir)) !==
        expectedFingerprint
      )
        throw new Error(
          "Review authoring changed while preparing repair. Retry after active writes finish.",
        );
      return { review, expectedRecord, expectedFingerprint };
    });
    const { review } = snapshot;
    const documentDir = path.join(temporaryRoot, "document");
    const mapDir = path.join(temporaryRoot, "map");
    const sourceFallback = { document: false, map: false };
    let documentChanged = false;
    let mapChanged = false;
    let mapRevision = review.presentedSoftwareMapRevision;
    let documentRevision = review.presentedDocumentRevision!;
    let presentation = review;
    await writePrivateJsonAtomic(path.join(stagingDir, "review.json"), review);
    try {
      await materializeReviewRevision(
        stagingDir,
        documentRevision,
        documentDir,
      );
      presentation = parseStoredReviewRecordForRecovery(
        parseJsonText(
          await readFile(path.join(documentDir, "review.json"), "utf8"),
        ),
      );
      const readyDocument = await readReviewDocumentBundle(documentDir, "/");
      if (!readyDocument) {
        const bundle = await convertSealedDocument(documentDir, input.warning);
        await writeReviewDocumentBundle(stagingDir, bundle);
        documentChanged = true;
      } else await writeReviewDocumentBundle(stagingDir, readyDocument);
    } catch (error) {
      sourceFallback.document = true;
      input.warning?.(
        `Sealed document conversion failed: ${message(error)}. Using editable review.mdx/data.ts; reconcile unpublished edits without changing the Review's meaning. Validation does not prove semantic equivalence.`,
      );
      const sourceReview = {
        ...review,
        baseRef: presentation.baseRef,
        baseCommit: presentation.baseCommit,
        sourceCommit: presentation.sourceCommit,
        sourceIdentity: presentation.sourceIdentity,
      };
      await writePrivateJsonAtomic(
        path.join(stagingDir, "review.json"),
        sourceReview,
      );
      try {
        await readFile(path.join(stagingDir, "review.mdx"), "utf8").catch(
          (error) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              throw new Error(
                `Missing editable Review input: ${path.join(input.reviewDir, "review.mdx")}. Restore that source file before retrying repair.`,
              );
            }
            throw error;
          },
        );
        const prepared = await prepareReviewDocumentBundle({
          review: { dir: stagingDir, review: sourceReview },
        });
        for (const warning of prepared.warnings) input.warning?.(warning);
      } catch (fallbackError) {
        throw new Error(
          `Document repair failed. Sealed input: ${message(error)}. Editable input: ${message(fallbackError).replaceAll(stagingDir, input.reviewDir)}`,
        );
      }
      documentChanged = true;
    }
    let mapPresentation = presentation;
    let mapPins = {
      baseCommit: presentation.baseCommit,
      headCommit: presentation.sourceCommit,
    };
    if (mapRevision) {
      let contradictoryMapPins = false;
      try {
        await materializeReviewRevision(stagingDir, mapRevision, mapDir);
        const embeddedMapRecord = parseStoredReviewRecordForRecovery(
          parseJsonText(
            await readFile(path.join(mapDir, "review.json"), "utf8"),
          ),
        );
        mapPresentation = embeddedMapRecord;
        mapPins = {
          baseCommit: embeddedMapRecord.baseCommit,
          headCommit: embeddedMapRecord.sourceCommit,
        };
        const manifest = await readFile(
          path.join(mapDir, ".bundle/software-map/manifest.json"),
          "utf8",
        )
          .then((value) => jsonObject(parseJsonText(value)))
          .catch(() => undefined);
        const manifestBase = jsonString(manifest?.baseCommit);
        const manifestHead = jsonString(manifest?.headCommit);
        if (
          manifestBase &&
          manifestHead &&
          /^[0-9a-f]{40}$/i.test(manifestBase) &&
          /^[0-9a-f]{40}$/i.test(manifestHead)
        ) {
          if (
            manifestBase !== mapPins.baseCommit ||
            manifestHead !== mapPins.headCommit
          ) {
            contradictoryMapPins = true;
            throw new Error(
              "Presented software-map manifest pins contradict its sealed Review record; reconcile this presentation before repair.",
            );
          }
          mapPins = { baseCommit: manifestBase, headCommit: manifestHead };
        }
        const readyMap = await readReviewSoftwareMapBundle(mapDir);
        if (!readyMap) {
          const bundle = await legacySoftwareMapBundle(mapDir);
          if (!bundle) {
            if (
              jsonObject(parseJsonText(snapshot.expectedRecord))
                ?.schemaVersion === 2
            )
              mapRevision = null;
            else throw new Error("The presented software map is missing.");
          } else {
            await writeReviewSoftwareMapBundle(stagingDir, bundle);
            mapChanged = true;
          }
        } else await writeReviewSoftwareMapBundle(stagingDir, readyMap);
      } catch (error) {
        if (contradictoryMapPins) throw error;
        sourceFallback.map = true;
        input.warning?.(
          `Sealed software map conversion failed: ${message(error)}. Validating saved map notes at the current presentation's pinned commits.`,
        );
        try {
          if (!mapPins.headCommit)
            throw new Error(
              "The current map presentation has no pinned head commit.",
            );
          const bundle = await prepareSavedMapNotes({
            rootPath: review.worktreePath,
            baseCommit: mapPins.baseCommit,
            headCommit: mapPins.headCommit,
          });
          await writeReviewSoftwareMapBundle(stagingDir, bundle);
        } catch (fallbackError) {
          throw new Error(
            `Software map repair failed. Sealed input: ${message(error)}. Saved map notes: ${message(fallbackError)}`,
          );
        }
        mapChanged = true;
      }
    }
    if (
      !documentChanged &&
      !mapChanged &&
      mapRevision === review.presentedSoftwareMapRevision &&
      jsonObject(parseJsonText(snapshot.expectedRecord))?.schemaVersion ===
        REVIEW_SCHEMA_VERSION
    ) {
      await cleanup();
      return { kind: "noop", review };
    }
    // Sealed document metadata retains the presentation's pinned source, even
    // when editable record pins have moved since its publication.
    let embedded = {
      ...review,
      baseRef: presentation.baseRef,
      baseCommit: presentation.baseCommit,
      sourceCommit: presentation.sourceCommit,
      sourceIdentity: presentation.sourceIdentity,
      presentedSoftwareMapRevision: mapRevision,
    };
    await writePrivateJsonAtomic(
      path.join(stagingDir, "review.json"),
      embedded,
    );
    if (mapChanged) {
      await writePrivateJsonAtomic(path.join(stagingDir, "review.json"), {
        ...embedded,
        baseRef: mapPresentation.baseRef,
        baseCommit: mapPins.baseCommit,
        sourceCommit: mapPins.headCommit,
        sourceIdentity: mapPresentation.sourceIdentity,
      });
      mapRevision = await sealReviewCandidate(
        stagingDir,
        "Repair current Review software map",
      );
      embedded = { ...embedded, presentedSoftwareMapRevision: mapRevision };
      await writePrivateJsonAtomic(
        path.join(stagingDir, "review.json"),
        embedded,
      );
    }
    if (documentChanged)
      documentRevision = await sealReviewCandidate(
        stagingDir,
        "Repair current Review document",
      );
    await writePrivateJsonAtomic(path.join(stagingDir, "review.json"), {
      ...review,
      presentedDocumentRevision: documentRevision,
      presentedSoftwareMapRevision: mapRevision,
    });
    return {
      kind: "prepared",
      review,
      cleanup,
      request: {
        reviewUuid: review.uuid,
        stagingDir,
        expectedRecord: snapshot.expectedRecord,
        expectedFingerprint: snapshot.expectedFingerprint,
        newDocumentRevision: documentRevision,
        newMapRevision: mapRevision,
        sourceFallback,
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Only internal writable trees are restricted; authored import symlinks are valid. */
async function assertIsolatedRepairInternals(dir: string): Promise<void> {
  const inspect = async (relative: string): Promise<void> => {
    const metadata = await lstat(path.join(dir, relative)).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!metadata) return;
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isDirectory() && !metadata.isFile())
    ) {
      throw new Error(
        `Repair internal path ${relative} is a symbolic link or special file. Restore ordinary artifact and private Git files before retrying repair.`,
      );
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path.join(dir, relative)))
        await inspect(path.join(relative, entry));
    }
  };
  await inspect(".bundle");
  await inspect(".git");
}

async function convertSealedDocument(
  dir: string,
  warning?: (message: string) => void,
) {
  let bundleDir = path.join(dir, ".bundle/document");
  let manifestText: string;
  try {
    manifestText = await readFile(
      path.join(bundleDir, "manifest.json"),
      "utf8",
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    bundleDir = path.join(dir, ".bundle");
    manifestText = await readFile(
      path.join(bundleDir, "manifest.json"),
      "utf8",
    );
  }
  if (jsonObject(parseJsonText(manifestText))?.version !== 1)
    throw new Error("The sealed document manifest is invalid or unsupported.");
  const evaluated = await evaluateReviewDocumentBundleForPublish({
    reviewDir: dir,
    bundleCode: await readFile(
      path.join(bundleDir, "review-document.js"),
      "utf8",
    ),
    validateRanges: false,
  });
  for (const item of evaluated.warnings) warning?.(item);
  if (!evaluated.document)
    throw new Error(
      evaluated.errors.join("; ") || "Sealed document did not materialize.",
    );
  return bundleReviewDocument(evaluated.document);
}

async function prepareSavedMapNotes(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
}) {
  const load = async (commit: string, role: "base" | "head") => {
    const source =
      (await readNote({
        rootPath: input.rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
      })) ??
      (await readNote({
        rootPath: input.rootPath,
        ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
        commit,
      }));
    if (source === null)
      throw new Error(
        `No saved software map note at ${role} commit ${commit}; author and validate that pinned map before retrying repair.`,
      );
    const checked = await checkSoftwareMapSource({
      repoRootPath: input.rootPath,
      commit,
      source,
      sourceName: `repair-${role}-map.ts`,
    });
    if (!checked.model || checked.errors.length)
      throw new Error(
        checked.errors.join("; ") || `Invalid saved ${role} map.`,
      );
    return checked.model;
  };
  const base = await load(input.baseCommit, "base");
  const head = await load(input.headCommit, "head");
  return bundleReviewSoftwareMap({
    base,
    head,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
  });
}
