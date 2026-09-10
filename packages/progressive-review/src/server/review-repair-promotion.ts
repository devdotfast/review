import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  type JsonValue,
  REVIEW_SCHEMA_VERSION,
  type ReviewDesktopGlobalEvent,
  type ReviewSessionDescriptor,
  type ReviewVerbResponse,
  jsonNumber,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { promoteReviewArtifactFiles } from "../review-artifact-promotion";
import { readReviewDocumentBundle } from "../review-bundle";
import {
  type StoredReview,
  allowsAbsentSoftwareMap,
  materializeReviewRevision,
  parseAnyStoredReviewRecord,
  parseStoredReviewRecord,
  refreshReviewMirror,
  reviewDescriptor,
} from "../review-home";
import { stableJson, withReviewMutationLock } from "../review-mutation-lock";
import {
  type ReviewRepairReadyRequest,
  type ReviewRepairReadyResponse,
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import {
  importLegacyReview,
  putReviewRecord,
  readReviewRecord,
} from "../review-state-db";
import {
  checkReviewThreadDbVersion,
  readReviewThreadDatabaseFingerprint,
} from "../review-thread-store-backend";
import { reviewVcs } from "../review-vcs";
import { readReviewSoftwareMapBundle } from "../software-map-bundle";
import { ReviewServerError } from "./http-json";
import { reviewWithPresentedDocumentPins } from "./publish-stage";
import {
  type ReviewSessionArtifactInput,
  legacySessionArtifactFromBuildDir,
} from "./review-session-artifact";

/** A staged seal may extend private objects and advance main/index, but cannot
 * replace repository config, remove history, or redirect writes through links. */
export async function validateRepairStagingRepository(
  dir: string,
  stagingDir: string,
): Promise<void> {
  for (const root of [dir, stagingDir]) {
    const metadata = await lstat(path.join(root, ".git"));
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Repair requires an isolated private Git directory.");
  }
  const compare = async (relative: string): Promise<void> => {
    const liveEntries = await readdir(path.join(dir, ".git", relative), {
      withFileTypes: true,
    });
    for (const entry of liveEntries) {
      const name = path.join(relative, entry.name);
      if (name === "index" || name === path.join("refs", "heads", "main"))
        continue;
      const staged = await lstat(path.join(stagingDir, ".git", name));
      if (entry.isSymbolicLink() || staged.isSymbolicLink())
        throw new Error(
          "Repair private Git metadata cannot contain symbolic links.",
        );
      if (entry.isDirectory()) {
        if (!staged.isDirectory())
          throw new Error("Prepared repair removed private history.");
        await compare(name);
      } else if (
        !staged.isFile() ||
        !(await readFile(path.join(dir, ".git", name))).equals(
          await readFile(path.join(stagingDir, ".git", name)),
        )
      )
        throw new Error(
          "Prepared repair changed existing private history or repository configuration.",
        );
    }
  };
  await compare("");
  const inspectStaged = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(stagingDir, ".git", relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error(
          "Repair private Git metadata cannot contain symbolic links or special files.",
        );
      const exists = await lstat(path.join(dir, ".git", name))
        .then(() => true)
        .catch(() => false);
      if (
        !exists &&
        name !== "index" &&
        name !== path.join("refs", "heads", "main") &&
        !/^objects\/[0-9a-f]{2}(?:\/[0-9a-f]{38})?$/.test(
          name.split(path.sep).join("/"),
        )
      )
        throw new Error(
          "Prepared repair added unexpected private Git metadata.",
        );
      if (entry.isDirectory()) await inspectStaged(name);
    }
  };
  await inspectStaged("");
  const oldHistory = await reviewVcs.log(dir);
  const newHistory = new Set(
    (await reviewVcs.log(stagingDir)).map((entry) => entry.oid),
  );
  if (oldHistory.some((entry) => !newHistory.has(entry.oid)))
    throw new Error("Prepared repair must retain existing private history.");
}

export async function assertReviewRepairInputsUnchanged(
  dir: string,
  request: ReviewRepairReadyRequest,
): Promise<void> {
  if (
    stableJson(readReviewRecord(dir)) !==
      stableJson(parseJsonText(request.expectedRecord)) ||
    (await fingerprintReviewRepairInputs(dir)) !== request.expectedFingerprint
  )
    throw new Error(
      "Review changed while preparing repair; retry without changing its pinned commits or review status.",
    );
  assertNoActiveReviewAgentWrites(dir);
  if (
    request.expectedThreadDbFingerprint &&
    readReviewThreadDatabaseFingerprint(path.join(dir, "review.mdx")) !==
      request.expectedThreadDbFingerprint
  )
    throw new Error("Review threads changed while preparing repair; retry.");
}

export async function readPreparedReviewRepairRecord(
  request: ReviewRepairReadyRequest,
) {
  const previous = parseAnyStoredReviewRecord(
    parseJsonText(request.expectedRecord),
  );
  if (previous.uuid !== request.reviewUuid)
    throw new Error("Repair review UUID does not match its record.");
  if (!previous.presentedDocumentRevision)
    throw new Error("A draft without a presentation must use review publish.");
  if (!previous.presentedSoftwareMapRevision && request.newMapRevision)
    throw new Error("Repair cannot invent an absent software map.");
  const storedSchemaVersion =
    jsonNumber(
      jsonObject(parseJsonText(request.expectedRecord))?.schemaVersion,
    ) ?? REVIEW_SCHEMA_VERSION;
  if (
    previous.presentedSoftwareMapRevision &&
    !request.newMapRevision &&
    !allowsAbsentSoftwareMap({ schemaVersion: storedSchemaVersion })
  )
    throw new Error("Repair cannot discard a presented software map.");
  const next = {
    ...previous,
    presentedDocumentRevision: request.newDocumentRevision,
    presentedSoftwareMapRevision: request.newMapRevision,
  };
  const prepared = parseStoredReviewRecord(
    parseJsonText(
      await readFile(path.join(request.stagingDir, "review.json"), "utf8"),
    ),
  );
  if (!isDeepStrictEqual(prepared, next))
    throw new Error(
      "Prepared repair must preserve review status, pins, title, timestamps and attention metadata.",
    );
  return next;
}

/** The only repair writer. Mount validation precedes this transaction; every
 * live input is checked again after acquiring the shared mutation lock. */
export async function applyPreparedReviewRepair(
  dir: string,
  request: ReviewRepairReadyRequest,
) {
  return withReviewMutationLock(dir, async () => {
    await assertReviewRepairInputsUnchanged(dir, request);
    const next = await readPreparedReviewRepairRecord(request);
    if (request.expectedThreadDbFingerprint)
      checkReviewThreadDbVersion(path.join(request.stagingDir, "review.mdx"));
    await promoteReviewArtifactFiles({
      reviewDir: dir,
      candidateDir: request.stagingDir,
      upgradeThreadDatabase: Boolean(request.expectedThreadDbFingerprint),
    });
    importLegacyReview(dir);
    putReviewRecord(dir, next);
    const warning = await refreshReviewMirror(dir, next);
    if (warning) console.warn(warning);
    return next;
  });
}

/** The subset of an active presentation session the promotion touches. */
export interface RepairPromotionSession {
  descriptor: { sessionId: string; sessionUrl: string };
  review: StoredReview;
  promoted: boolean;
  closing: boolean;
}

/** The CLI already validated, bundled, and sealed the revision; the server
 * materializes it, has the app mount it off-screen, and promotes it only
 * when that mount is clean. */
export async function promoteReviewRepair<
  Session extends RepairPromotionSession & {
    descriptor: ReviewSessionDescriptor;
  },
>(input: {
  review: StoredReview;
  request: ReviewRepairReadyRequest;
  sessions: ReadonlyMap<string, Session>;
  registerSerialized: (registration: {
    review: StoredReview;
    artifact: ReviewSessionArtifactInput;
    revision: string;
    promoted: false;
    repairValidation: true;
    readOnlyThreadsPath?: string;
  }) => Promise<Session>;
  withReviewLock: <T>(
    reviewUuid: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  dispatch: (sessionId: string, verb: JsonValue) => Promise<ReviewVerbResponse>;
  startSessionTelemetry: (session: Session) => Promise<void>;
  closeSession: (
    session: Session,
    reason: "closed" | "replaced",
  ) => Promise<void>;
  broadcast: (event: ReviewDesktopGlobalEvent) => void;
  onPromoted?: () => void;
}): Promise<ReviewRepairReadyResponse> {
  const { review, request } = input;
  const stagingDir = await realpath(request.stagingDir);
  const liveDir = await realpath(review.dir);
  const relative = path.relative(liveDir, stagingDir);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error("Repair staging must be isolated from the stored review.");
  await input.withReviewLock(request.reviewUuid, () =>
    assertReviewRepairInputsUnchanged(review.dir, request),
  );
  await validateRepairStagingRepository(review.dir, stagingDir);
  const next = await readPreparedReviewRepairRecord(request);
  const stageFingerprint = await fingerprintReviewRepairInputs(stagingDir);
  const stagedThreadDbFingerprint = request.expectedThreadDbFingerprint
    ? readReviewThreadDatabaseFingerprint(path.join(stagingDir, "review.mdx"))
    : undefined;
  const createdBuilds: string[] = [];
  let successor: Session | undefined;
  try {
    const materialize = async (revision: string) => {
      const destination = path.join(review.dir, ".build", revision);
      if (!existsSync(destination)) {
        createdBuilds.push(destination);
        try {
          await materializeReviewRevision(stagingDir, revision, destination);
        } catch (error) {
          await rm(destination, { recursive: true, force: true });
          throw error;
        }
      }
      return destination;
    };
    const materializedRecord = async (revision: string) =>
      materialize(revision)
        .then(async (root) =>
          parseAnyStoredReviewRecord(
            JSON.parse(await readFile(path.join(root, "review.json"), "utf8")),
          ),
        )
        .catch(() => null);
    const documentDir = await materialize(request.newDocumentRevision);
    const mapDir = request.newMapRevision
      ? await materialize(request.newMapRevision)
      : undefined;
    if (!(await readReviewDocumentBundle(documentDir, "/")))
      throw new ReviewServerError(
        "Repaired document JSON is invalid.",
        422,
        "repair_document_invalid",
      );
    const presented = await reviewWithPresentedDocumentPins(
      { dir: review.dir, review: next },
      documentDir,
    );
    const expectedDocumentPins =
      (review.review.presentedDocumentRevision
        ? await materializedRecord(review.review.presentedDocumentRevision)
        : null) ?? review.review;
    if (
      presented.review.baseCommit !== expectedDocumentPins.baseCommit ||
      presented.review.sourceCommit !== expectedDocumentPins.sourceCommit ||
      presented.review.baseRef !== expectedDocumentPins.baseRef ||
      JSON.stringify(presented.review.sourceIdentity) !==
        JSON.stringify(expectedDocumentPins.sourceIdentity)
    )
      throw new ReviewServerError(
        "Repaired document must preserve its presentation's pinned commits.",
        422,
        "repair_document_pins",
      );
    if (mapDir) {
      const map = await readReviewSoftwareMapBundle(mapDir);
      if (!map)
        throw new ReviewServerError(
          "Repaired software map JSON is invalid.",
          422,
          "repair_map_invalid",
        );
      const expectedMapPins =
        (review.review.presentedSoftwareMapRevision
          ? await materializedRecord(review.review.presentedSoftwareMapRevision)
          : null) ?? presented.review;
      if (
        map.baseCommit !== expectedMapPins.baseCommit ||
        map.headCommit !== expectedMapPins.sourceCommit
      )
        throw new ReviewServerError(
          "Repaired software map must preserve its presentation's pinned commits.",
          422,
          "repair_map_pins",
        );
    }
    successor = await input.registerSerialized({
      review: presented,
      artifact: await legacySessionArtifactFromBuildDir({
        reviewUuid: presented.review.uuid,
        revision: request.newDocumentRevision,
        buildDir: documentDir,
        routePath: "/",
        softwareMapRootPath: mapDir,
        sourcePath: path.join(presented.dir, "review.mdx"),
      }),
      revision: request.newDocumentRevision,
      promoted: false,
      repairValidation: true,
      readOnlyThreadsPath: request.expectedThreadDbFingerprint
        ? path.join(stagingDir, "review.mdx")
        : undefined,
    });
    const validation = await input.dispatch(successor.descriptor.sessionId, {
      name: "validateCanvasMount",
      args: {},
    });
    if (!validation.ok)
      throw new ReviewServerError(
        `Repaired Review failed to mount: ${validation.error ?? "unknown error"}`,
        422,
        "repair_mount_failed",
      );
    const mounted = successor;
    await input.withReviewLock(request.reviewUuid, async () => {
      if (
        mounted.closing ||
        input.sessions.get(mounted.descriptor.sessionId) !== mounted
      )
        throw new Error("Repair validation session closed before promotion.");
      if (
        (await fingerprintReviewRepairInputs(stagingDir)) !==
          stageFingerprint ||
        (stagedThreadDbFingerprint !== undefined &&
          readReviewThreadDatabaseFingerprint(
            path.join(stagingDir, "review.mdx"),
          ) !== stagedThreadDbFingerprint)
      )
        throw new Error(
          "Prepared repair changed after mount validation; retry.",
        );
      mounted.review = {
        dir: review.dir,
        review: await applyPreparedReviewRepair(review.dir, request),
      };
      mounted.promoted = true;
      input.onPromoted?.();
    });
    // Once promoted, UI refresh failures cannot turn a committed repair into a failed command.
    await input.startSessionTelemetry(mounted).catch(() => undefined);
    const descriptor = await reviewDescriptor(mounted.review, {
      threads: "read-only",
    }).catch(() => undefined);
    input.broadcast({
      event: "session-registered",
      session: mounted.descriptor,
      review: descriptor,
    });
    await Promise.all(
      [...input.sessions.values()]
        .filter(
          (session) =>
            session !== mounted &&
            session.promoted &&
            session.review.review.uuid === request.reviewUuid,
        )
        .map((session) =>
          input.closeSession(session, "replaced").catch(() => undefined),
        ),
    );
    void input.dispatch(mounted.descriptor.sessionId, {
      name: "focusCanvas",
      args: {},
    });
    return {
      ok: true,
      status: next.status,
      oldDocumentRevision: review.review.presentedDocumentRevision,
      oldMapRevision: review.review.presentedSoftwareMapRevision,
      newDocumentRevision: request.newDocumentRevision,
      newMapRevision: request.newMapRevision,
      sessionId: mounted.descriptor.sessionId,
      url: mounted.descriptor.sessionUrl,
    };
  } finally {
    if (!successor?.promoted) {
      if (successor)
        await input.closeSession(successor, "closed").catch(() => undefined);
      for (const build of createdBuilds)
        await rm(build, { recursive: true, force: true });
    }
  }
}
