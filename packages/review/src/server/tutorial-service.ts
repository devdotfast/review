import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { resolveRevision } from "@dev.fast/local-vcs";
import type { ReviewDescriptor } from "@dev.fast/review-protocol";
import { writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

import { documentSchema, resourceReferences } from "../review-api/document";
import type { LocalReviewData } from "../review-api/local-data";
import type { ReviewStore, Snapshot } from "../review-api/store";
import { devReviewHome } from "../review-home-paths";

const authoredSchema = z.strictObject({
  title: z.string().min(1),
  document: documentSchema,
});

const pinsSchema = z.strictObject({
  base: z.string().regex(/^[a-f0-9]{40}$/),
  head: z.string().regex(/^[a-f0-9]{40}$/),
});

const stampSchema = z.object({
  version: z.literal(10),
  reviewUuid: z.string(),
  contentHash: z.string(),
});

export async function readTutorialAssets(assetsRoot: string) {
  const names = [
    "document.json",
    "trace.json",
    "software-map.json",
    "pins.json",
  ];

  const bytes = await Promise.all(
    names.map((name) => readFile(path.join(assetsRoot, name), "utf8")),
  );

  return {
    authored: authoredSchema.parse(JSON.parse(bytes[0]!)),
    trace: JSON.parse(bytes[1]!),
    model: JSON.parse(bytes[2]!),
    pins: pinsSchema.parse(JSON.parse(bytes[3]!)),
    contentHash: createHash("sha256")
      .update(JSON.stringify(bytes))
      .digest("hex"),
  };
}

/** Create the shipped document through the same strict validation as authored reviews. */
export async function createNativeTutorial(input: {
  assetsRoot: string;
  sampleRoot: string;
  store: ReviewStore;
  data: LocalReviewData;
}) {
  const assets = await readTutorialAssets(input.assetsRoot);
  const repository = await input.data.register(input.sampleRoot);

  const pins = await input.data.resolvePins(
    repository.id,
    assets.pins.base,
    assets.pins.head,
  );

  const aliases = new Map<string, string>();
  const traceId = randomUUID();
  await input.data.upload({
    id: traceId,
    repositoryId: repository.id,
    kind: "trace",
    trace: assets.trace,
  });
  aliases.set("tutorial-trace", traceId);

  for (const side of ["base", "head"] as const) {
    const id = randomUUID();
    await input.data.upload({
      id,
      repositoryId: repository.id,
      kind: "map",
      pins,
      side,
      model: assets.model,
    });
    aliases.set(`tutorial-map-${side}`, id);
  }

  for (const block of resourceReferences(assets.authored.document)) {
    if (block.type === "trace_quote")
      block.traceId = aliases.get(block.traceId) ?? block.traceId;

    if (block.type === "software_map")
      block.mapVersionId =
        aliases.get(block.mapVersionId) ?? block.mapVersionId;
  }

  const result = await input.store.execute(
    {
      commandId: randomUUID(),
      operation: { type: "create", title: assets.authored.title, pins },
    },
    { document: assets.authored.document, origin: { tutorial: true } },
  );

  return {
    snapshot: input.store.read(result.reviewId),
    contentHash: assets.contentHash,
  };
}

export function createTutorialService(input: {
  packageRoot: string;
  store?: ReviewStore;
  data?: LocalReviewData;
}) {
  const tutorialRoot = path.join(devReviewHome(), "tutorial");
  const sampleRoot = path.join(tutorialRoot, "sample-service");
  const stampPath = path.join(tutorialRoot, "stamp.json");
  const assetsRoot = path.join(input.packageRoot, "tutorial");

  const readStamp = async () =>
    stampSchema.safeParse(
      await readFile(stampPath, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null),
    ).data;

  async function find(): Promise<Snapshot | null> {
    try {
      const stamp = await readStamp();

      if (!stamp || !input.store?.has(stamp.reviewUuid)) return null;
      const snapshot = input.store.read(stamp.reviewUuid);
      const assets = await readTutorialAssets(assetsRoot);

      const [head, base] = await Promise.all([
        resolveRevision(sampleRoot, "HEAD"),
        resolveRevision(sampleRoot, "HEAD^"),
      ]);

      return snapshot.origin?.tutorial &&
        stamp.contentHash === assets.contentHash &&
        snapshot.pins.head === head?.commit &&
        snapshot.pins.base === base?.commit &&
        head.commit === assets.pins.head &&
        base.commit === assets.pins.base
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }

  async function cleanup() {
    for (const reviewId of input.store?.tutorialIds() ?? [])
      await input.store!.execute({
        commandId: randomUUID(),
        operation: { type: "delete", reviewId },
      });
    await rm(tutorialRoot, { recursive: true, force: true });
  }

  return {
    find,
    async status() {
      return {
        version: 1 as const,
        reviewUuid: (await find())?.reviewId ?? null,
      };
    },
    async referencesReview(id: string) {
      return (
        input.store?.has(id) === true &&
        input.store.read(id).origin?.tutorial === true
      );
    },
    async prepare(options?: { beforeReset(): Promise<void> }) {
      const current = await find();

      if (current) return current;

      if (!input.store || !input.data)
        throw new Error("Tutorial requires the native review store.");
      await readTutorialAssets(assetsRoot);
      await options?.beforeReset();
      await cleanup();
      await mkdir(tutorialRoot, { recursive: true, mode: 0o700 });

      const temporaryRoot = path.join(
        tutorialRoot,
        `.sample-service-${randomUUID()}`,
      );

      try {
        await cp(path.join(assetsRoot, "sample-service"), temporaryRoot, {
          recursive: true,
        });
        await cp(
          path.join(assetsRoot, "git-stub"),
          path.join(temporaryRoot, ".git"),
          { recursive: true },
        );
        await rename(temporaryRoot, sampleRoot);

        const { snapshot, contentHash } = await createNativeTutorial({
          assetsRoot,
          sampleRoot,
          store: input.store,
          data: input.data,
        });

        await writePrivateJsonAtomic(stampPath, {
          version: 10,
          reviewUuid: snapshot.reviewId,
          contentHash,
        });

        return snapshot;
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    descriptor(snapshot: Snapshot): ReviewDescriptor {
      return {
        uuid: snapshot.reviewId,
        title: snapshot.title,
        status: "awaiting-review",
        worktreePath: sampleRoot,
        repoKey: snapshot.pins.repositoryId,
        sourceBranch: "main",
        baseRef: snapshot.pins.base,
        headRef: snapshot.pins.head,
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
        lastPublishedAt: snapshot.createdAt,
        available: true,
      };
    },
    cleanup,
  };
}
