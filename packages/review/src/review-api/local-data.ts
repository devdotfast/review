import { realpath } from "node:fs/promises";

import {
  detectLocalVcs,
  diffFileSummariesTrees,
  diffTrees,
  listCommitRange,
  listTrackedFiles,
  readFileAtRevision,
  resolveRevision,
} from "@dev.fast/local-vcs";
import type { ReviewSourceEntry } from "@dev.fast/review-protocol";
import { z } from "zod";

import { resolveSoftwareMapDiffCounts } from "../software-map-diff-counts.js";
import {
  type NormalizedSoftwareModel,
  SoftwareModelValidationError,
  defineSoftwareMap,
} from "../software-map-model.js";
import {
  SourceRangeError,
  checkSourcePath,
  requireVisibleSource,
  sliceSourceRange,
} from "../source.js";
import {
  type Block,
  type Pins,
  ReviewInputError,
  type Source,
  pinsSchema,
  sourceSchema,
} from "./document.js";
import { mapInputSchema } from "./map-input.js";
import { ReviewStore } from "./store.js";

const traceSchema = z.strictObject({
  label: z.string(),
  events: z.array(
    z.strictObject({
      id: z.string().min(1),
      role: z.enum(["user", "assistant", "tool"]),
      text: z.string(),
    }),
  ),
});

export const uploadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: z.uuid(),
    repositoryId: z.string(),
    kind: z.literal("image"),
    base64: z.string(),
  }),
  z.strictObject({
    id: z.uuid(),
    repositoryId: z.string(),
    kind: z.literal("trace"),
    trace: traceSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    repositoryId: z.string(),
    kind: z.literal("map"),
    pins: pinsSchema,
    side: z.enum(["base", "head"]),
    model: mapInputSchema,
  }),
]);

/** File reads cannot name the root or a directory; tree reads can. */
function checkRelativePath(file: string) {
  inputError(() => checkSourcePath(file));
  if (file === "" || file.endsWith("/"))
    throw new ReviewInputError(
      "Source file must be a repository-relative path.",
    );
}

function sliceRange(file: { commit: string; text: string }, source: Source) {
  return {
    ...source,
    commit: file.commit,
    text: inputError(() => sliceSourceRange(file.text, source)),
  };
}

/** Local implementation of the host's source/resource boundary. No client gets a filesystem path. */
export class LocalReviewData {
  // A commit's tree never changes, so one listing serves every folder expansion.
  private readonly trackedFiles = new Map<string, Promise<string[]>>();
  constructor(private readonly store: ReviewStore) {}
  async register(root: string) {
    const resolved = await realpath(root).catch(() => {
      throw new ReviewInputError(
        "Repository path does not exist or is not readable.",
      );
    });

    const vcs = await detectLocalVcs(resolved);

    if (!vcs) throw new ReviewInputError("Choose a Git or jj repository.");

    return this.store.registerRepository(await realpath(vcs.rootPath));
  }
  async resolvePins(
    repositoryId: string,
    base: string,
    head: string,
  ): Promise<Pins> {
    const root = this.store.repositoryPath(repositoryId);

    const [left, right] = await Promise.all([
      resolveRevision(root, base),
      resolveRevision(root, head),
    ]);

    if (!left || !right)
      throw new ReviewInputError("Base or head revision does not exist.");

    return { repositoryId, base: left.commit, head: right.commit };
  }
  async validatePins(pins: Pins) {
    const resolved = await this.resolvePins(
      pins.repositoryId,
      pins.base,
      pins.head,
    );

    if (resolved.base !== pins.base || resolved.head !== pins.head)
      throw new ReviewInputError(
        "Use resolved commit IDs, not moving branch names.",
      );
  }
  async file(pins: Pins, side: "base" | "head", file: string) {
    checkRelativePath(file);

    const result = await readFileAtRevision({
      rootPath: this.store.repositoryPath(pins.repositoryId),
      ref: pins[side],
      relativePath: file,
    });

    // `git show <commit>:<dir>` prints a "tree <commit>:<dir>" listing instead of failing.
    if (
      !result ||
      result.commit !== pins[side] ||
      result.source.startsWith(`tree ${result.commit}:`)
    )
      throw new ReviewInputError(
        "File is unavailable at the pinned commit.",
        404,
      );

    if (result.source.includes("\0"))
      throw new ReviewInputError(
        "Binary files cannot be used as code references.",
      );

    return { file, side, commit: result.commit, text: result.source };
  }

  async tree(
    pins: Pins,
    side: "base" | "head",
    directory: string,
  ): Promise<ReviewSourceEntry[]> {
    inputError(() => checkSourcePath(directory));
    const prefix = directory ? directory.replace(/\/$/, "") + "/" : "";
    const entries = new Map<string, ReviewSourceEntry>();

    for (const file of await this.trackedFilesAt(
      pins.repositoryId,
      pins[side],
    )) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      const name = relative.split("/", 1)[0]!;
      entries.set(name, {
        path: prefix + name,
        kind: relative.includes("/") ? "directory" : "file",
      });
    }

    if (directory && entries.size === 0)
      throw new ReviewInputError(
        "Directory is unavailable at the pinned commit.",
        404,
      );

    return [...entries.values()];
  }
  private trackedFilesAt(repositoryId: string, ref: string) {
    const rootPath = this.store.repositoryPath(repositoryId);
    const key = `${repositoryId}\0${ref}`;
    let files = this.trackedFiles.get(key);

    if (!files) {
      files = listTrackedFiles({ rootPath, ref });
      this.trackedFiles.set(key, files);
      files.catch(() => this.trackedFiles.delete(key));
    }

    return files;
  }
  async quote(pins: Pins, source: Source) {
    source = sourceSchema.parse(source);

    return sliceRange(await this.file(pins, source.side, source.file), source);
  }
  /** Every source reference must exist at the pins; only code peeks must also
   * show something. */
  async validateSource(pins: Pins, source: Source, options: { peek: boolean }) {
    const quote = await this.quote(pins, source);

    if (options.peek)
      inputError(() => requireVisibleSource(quote.text, source));
  }
  async changes(pins: Pins, file?: string) {
    if (file !== undefined) checkRelativePath(file);

    const input = {
      rootPath: this.store.repositoryPath(pins.repositoryId),
      baseRef: pins.base,
      headRef: pins.head,
    };

    return file === undefined
      ? diffFileSummariesTrees(input)
      : diffTrees({ ...input, paths: [file], literalPaths: true });
  }
  // Pins are immutable commit ids, so a listed range never changes.
  private readonly commitLists = new Map<
    string,
    ReturnType<typeof listCommitRange>
  >();
  commits(pins: Pins) {
    const key = JSON.stringify([pins.repositoryId, pins.base, pins.head]);
    let commits = this.commitLists.get(key);

    if (!commits) {
      commits = listCommitRange({
        rootPath: this.store.repositoryPath(pins.repositoryId),
        baseRef: pins.base,
        headRef: pins.head,
      });
      commits.catch(() => this.commitLists.delete(key));
      this.commitLists.set(key, commits);
    }

    return commits;
  }
  async comparison(pins: Pins, commit?: string): Promise<Pins> {
    if (!commit) return pins;

    const selected = (await this.commits(pins)).find(
      (item) => item.commit === commit,
    );

    if (!selected)
      throw new ReviewInputError(
        "The selected commit is not part of this review version.",
        404,
      );

    return { ...pins, base: selected.parentCommit, head: selected.commit };
  }
  async map(pins: Pins, resourceId: string) {
    await this.validateResource(pins, {
      type: "software_map",
      mapVersionId: resourceId,
    });

    // SAFETY: map resources are normalized and validated by upload before storage.
    const saved = JSON.parse(
      Buffer.from(this.store.resource(resourceId).data).toString(),
    ) as Pick<NormalizedSoftwareModel, "elements" | "relationships"> & {
      side: "base" | "head";
      commit: string;
    };

    const resolved = await resolveSoftwareMapDiffCounts({
      sourceRootPath: this.store.repositoryPath(pins.repositoryId),
      baseRef: pins.base,
      headRef: pins.head,
      side: saved.side,
      codeElements: saved.elements.filter(
        (element) => element.type === "codeElement",
      ),
      coverageClaims: saved.elements.flatMap((element) =>
        element.coverage ? [{ path: element.path, ...element.coverage }] : [],
      ),
    });

    return {
      ...saved,
      countsByElementPath: resolved.countsByElementPath,
      unmappedByElementPath: resolved.unmappedByElementPath,
    };
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Upload boundary: uploadSchema.parse below validates incoming JSON.
  async upload(value: unknown) {
    const input = uploadSchema.parse(value);
    this.store.repositoryPath(input.repositoryId);

    let mimeType = "application/json",
      data: Uint8Array;

    switch (input.kind) {
      case "image": {
        // Load the native decoder only here, so a missing platform binary fails one upload, not host startup.
        const { default: sharp } = await import("sharp");

        try {
          const decoder = sharp(Buffer.from(input.base64, "base64"), {
            limitInputPixels: 20_000_000,
            failOn: "warning",
          });

          const metadata = await decoder.metadata();

          if (
            !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
            (metadata.pages ?? 1) !== 1
          )
            throw new Error("Unsupported image");
          // One bounded full decode; retain a safe raster format, not the original file.
          data = await decoder.png().toBuffer();
          mimeType = "image/png";
        } catch {
          throw new ReviewInputError(
            "Provide a valid single PNG, JPEG, or WebP image (at most 20 megapixels).",
          );
        }

        break;
      }

      case "trace":
        if (
          new Set(input.trace.events.map((event) => event.id)).size !==
          input.trace.events.length
        )
          throw new ReviewInputError("Trace event IDs must be unique.");
        data = Buffer.from(
          JSON.stringify({ ...input.trace, provenance: "client_supplied" }),
        );
        break;
      case "map": {
        if (input.pins.repositoryId !== input.repositoryId)
          throw new ReviewInputError("Map belongs to a different repository.");
        await this.validatePins(input.pins);
        let model;

        try {
          model = defineSoftwareMap(input.model);
        } catch (error) {
          if (error instanceof SoftwareModelValidationError)
            throw new ReviewInputError(error.message);
          throw error;
        }

        // Read each pinned file once, then check every range against it concurrently.
        const files = new Map<string, ReturnType<LocalReviewData["file"]>>();

        await Promise.all(
          model.elements.flatMap((element) =>
            (element.sourceRanges ?? []).map(async (source) => {
              const range = sourceSchema.parse({ ...source, side: input.side });
              let read = files.get(range.file);

              if (!read)
                files.set(
                  range.file,
                  (read = this.file(input.pins, range.side, range.file)),
                );
              sliceRange(await read, range);
            }),
          ),
        );
        data = Buffer.from(
          JSON.stringify({
            commit: input.pins[input.side],
            side: input.side,
            elements: model.elements,
            relationships: model.relationships,
          }),
        );
        break;
      }
    }

    return this.store.putResource(
      input.id,
      input.repositoryId,
      input.kind,
      mimeType,
      data,
    );
  }
  async validateResource(pins: Pins, block: Block) {
    if (
      block.type !== "image" &&
      block.type !== "trace_quote" &&
      block.type !== "software_map"
    )
      return;

    const id =
      block.type === "image"
        ? block.assetId
        : block.type === "trace_quote"
          ? block.traceId
          : block.mapVersionId;

    const resource = this.store.resource(id);

    const kind =
      block.type === "image"
        ? "image"
        : block.type === "trace_quote"
          ? "trace"
          : "map";

    if (resource.repositoryId !== pins.repositoryId || resource.kind !== kind)
      throw new ReviewInputError(
        "Resource belongs to a different repository or component type.",
      );

    if (block.type === "trace_quote") {
      const trace = traceSchema
        .passthrough()
        .parse(JSON.parse(Buffer.from(resource.data).toString()));

      if (
        !trace.events
          .find((event) => event.id === block.eventId)
          ?.text.includes(block.text)
      )
        throw new ReviewInputError(
          "Quote does not match the retained trace event.",
        );
    }

    if (block.type === "software_map") {
      // SAFETY: map resources are normalized and validated by upload before storage.
      const map = JSON.parse(Buffer.from(resource.data).toString()) as {
        commit: string;
        side: "base" | "head";
        elements: { id: string; path: string }[];
      };

      if (map.commit !== pins[map.side])
        throw new ReviewInputError(
          "Map does not match this review's source pins.",
        );

      if (
        block.focusElementId &&
        !map.elements.some(
          (element) =>
            element.id === block.focusElementId ||
            element.path === block.focusElementId,
        )
      )
        throw new ReviewInputError("Map focus element does not exist.");
    }
  }
}

/** The pure source checks throw their own error; API clients see it as input. */
function inputError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SourceRangeError)
      throw new ReviewInputError(error.message);
    throw error;
  }
}

export function openLocalReviewStore(databasePath: string) {
  const store: ReviewStore = new ReviewStore(databasePath, {
    validatePins: (pins) => data.validatePins(pins),
    validateSource: (pins, source, options) =>
      data.validateSource(pins, source, options),
    validateResource: (pins, block) => data.validateResource(pins, block),
  });

  const data = new LocalReviewData(store);

  return { store, data };
}
