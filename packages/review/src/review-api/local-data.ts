import { type FSWatcher, existsSync, watch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";

import {
  type BlobBatchReader,
  type LocalVcs,
  type LocalVcsCommitSummary,
  type LocalVcsDiffFileSummary,
  type LocalVcsKind,
  createBlobBatchReader,
  detectLocalVcs,
  diffFileSummariesTrees,
  diffTrees,
  gitCommonDir,
  listCommitRange,
  listTrackedFilesAtCommit,
  readFileAtCommit,
} from "@dev.fast/local-vcs";
import type { ReviewSourceEntry } from "@dev.fast/review-protocol";
import { z } from "zod";

import { textIncludesQuote } from "../evidence.js";
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
  type ReviewTarget,
  type Source,
  elements,
  pinsSchema,
  sourceReferences,
  sourceSchema,
} from "./document.js";
import { decodeImage } from "./image-decode.js";
import { mapInputSchema } from "./map-input.js";
import { sourceDiff } from "./source-diff.js";
import { mapSourceRange } from "./source-ranges.js";
import { ReviewStore, type Snapshot } from "./store.js";
import { ReviewWorkspaces } from "./workspaces.js";
import {
  EMPTY_SOURCE,
  captureWorktree,
  localSourcePath,
  retainedWorktree,
} from "./worktree-source.js";

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

interface RepositoryVcs {
  detection: Promise<LocalVcs | null>;
  vcs?: LocalVcs;
}

/** Local source/resource boundary, including Desktop-only local language context. */
export class LocalReviewData {
  readonly workspaces: ReviewWorkspaces;

  /** Local checkout context for live worktree targets only. */
  /** Desktop language services borrow the registered checkout, never create one. */
  async liveFile(repositoryId: string, file: string, text: string) {
    try {
      const rootPath = await realpath(this.store.repositoryPath(repositoryId));
      const localPath = await localSourcePath(rootPath, file);

      if ((await readFile(localPath, "utf8")) === text)
        return { localPath, localRoot: rootPath };
    } catch {
      /* A moved or changed file falls back to retained source. */
    }

    return undefined;
  }
  async languageContext(
    repositoryId: string,
  ): Promise<{ rootPath: string | null }> {
    const rootPath = this.store.repositoryPath(repositoryId);
    const resolved = await realpath(rootPath).catch(() => null);

    if (!resolved) return { rootPath: null };
    const vcs = await detectLocalVcs(resolved);

    return { rootPath: vcs ? resolved : null };
  }

  // A commit's tree never changes, so one listing serves every folder expansion.
  private readonly trackedFiles = new Map<string, Promise<string[]>>();

  private readonly repositories = new Map<string, RepositoryVcs>();

  private readonly readers = new Map<string, BlobBatchReader>();

  private readonly commitRanges = new Map<
    string,
    Promise<LocalVcsCommitSummary[]>
  >();

  constructor(
    private readonly store: ReviewStore,
    private readonly options: {
      blobReaderIdleTimeoutMs?: number;
      workspaceDatabase?: string;
    } = {},
  ) {
    this.workspaces = new ReviewWorkspaces(
      options.workspaceDatabase ?? ":memory:",
      store,
    );
  }

  private closed = false;
  private readonly worktrees = new Map<
    string,
    {
      epoch: number;
      capturedEpoch: number;
      watchers: FSWatcher[];
      capture?: Awaited<ReturnType<typeof captureWorktree>>;
    }
  >();

  private forgetWorktree(repositoryId: string) {
    const entry = this.worktrees.get(repositoryId);

    if (entry) for (const watcher of entry.watchers) watcher.close();
    this.worktrees.delete(repositoryId);
  }

  private async capture(repositoryId: string, vcs: LocalVcs) {
    let entry = this.worktrees.get(repositoryId);

    if (!entry) {
      entry = { epoch: 0, capturedEpoch: -1, watchers: [] };
      this.worktrees.set(repositoryId, entry);
      const state = entry;
      const roots = new Set([vcs.rootPath]);
      const common = await gitCommonDir(vcs.rootPath);

      if (common) roots.add(common);

      for (const root of roots) {
        try {
          const watcher = watch(root, { recursive: true }, () => {
            state.epoch++;
          });

          watcher.on("error", () => {
            state.epoch++;
            state.capturedEpoch = -1;
          });
          watcher.unref();
          state.watchers.push(watcher);
        } catch {
          /* An unavailable watcher disables the cache below. */
        }
      }
    }

    if (
      entry.capture &&
      entry.capturedEpoch === entry.epoch &&
      entry.watchers.length
    )
      return entry.capture;

    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = entry.epoch;

      const captured = await captureWorktree(
        this.store,
        repositoryId,
        vcs,
        entry.capture,
      );

      if (entry.epoch !== epoch) continue;
      entry.capture = captured;
      entry.capturedEpoch = epoch;

      return captured;
    }

    throw new ReviewInputError(
      "The worktree is changing. Retry after saving finishes.",
      409,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.workspaces.close();

    for (const entry of this.worktrees.values())
      for (const watcher of entry.watchers) watcher.close();
    this.worktrees.clear();
    const readers = [...this.readers.values()];

    this.readers.clear();

    await Promise.all(readers.map((reader) => reader.close()));
  }

  /** Detected once; dropped when the root vanishes or detection found nothing. */
  private vcs(repositoryId: string): Promise<LocalVcs | null> {
    const cached = this.repositories.get(repositoryId);

    if (cached && (!cached.vcs || existsSync(cached.vcs.rootPath)))
      return cached.detection;

    this.closeReader(repositoryId);
    this.forgetWorktree(repositoryId);
    const rootPath = this.store.repositoryPath(repositoryId);

    const forget = () => {
      this.repositories.delete(repositoryId);
      this.closeReader(repositoryId);
    };

    const entry: RepositoryVcs = {
      detection: detectLocalVcs(rootPath).then(
        (vcs) => {
          if (vcs) entry.vcs = vcs;
          else forget();

          return vcs;
        },
        (cause: unknown) => {
          forget();

          throw cause;
        },
      ),
    };

    this.repositories.set(repositoryId, entry);

    return entry.detection;
  }

  /** None once closed: a read suspended across close() gets its own process. */
  private reader(
    repositoryId: string,
    vcs: LocalVcs,
  ): BlobBatchReader | undefined {
    if (this.closed) return undefined;
    const existing = this.readers.get(repositoryId);

    if (existing) return existing;

    const reader = createBlobBatchReader({
      rootPath: vcs.rootPath,
      kind: vcs.kind,
      idleTimeoutMs: this.options.blobReaderIdleTimeoutMs,
    });

    this.readers.set(repositoryId, reader);

    return reader;
  }

  private closeReader(repositoryId: string): Promise<void> | undefined {
    const reader = this.readers.get(repositoryId);

    if (!reader) return;
    this.readers.delete(repositoryId);

    return reader.close();
  }

  private async vcsTarget(
    repositoryId: string,
  ): Promise<{ rootPath: string; kind?: LocalVcsKind }> {
    const vcs = await this.vcs(repositoryId);

    return vcs
      ? { rootPath: vcs.rootPath, kind: vcs.kind }
      : { rootPath: this.store.repositoryPath(repositoryId) };
  }

  async register(root: string) {
    const resolved = await realpath(root).catch(() => {
      throw new ReviewInputError(
        "Repository path does not exist or is not readable.",
      );
    });

    const vcs = await detectLocalVcs(resolved);

    if (!vcs) throw new ReviewInputError("Choose a Git or jj repository.");

    const repository = this.store.registerRepository(
      await realpath(vcs.rootPath),
    );

    // Registration may follow replacement of a managed repository at the same
    // path (for example resetting the tutorial). Reopen its Git reader too.
    await this.closeReader(repository.id);
    this.repositories.delete(repository.id);

    return repository;
  }
  async projectSource(snapshot: Snapshot, pins: Pins): Promise<Snapshot> {
    const projected = structuredClone(snapshot);
    projected.staleSources = [...(snapshot.staleSources ?? [])];

    for (const reference of sourceReferences(projected.document, {
      tolerant: true,
    })) {
      if (
        reference.source.side !== "head" ||
        projected.staleSources.includes(reference.id)
      )
        continue;

      try {
        const [before, after] = await Promise.all([
          this.file(snapshot.pins, "head", reference.source.file),
          this.file(pins, "head", reference.source.file),
        ]);

        const mapped = await mapSourceRange(
          reference.source,
          before.text,
          after.text,
        );

        if (!mapped) {
          projected.staleSources.push(reference.id);
          continue;
        }

        if (reference.id.includes(":review-source:")) {
          const index = reference.id.indexOf(":review-source:");

          const element = elements(projected.document).find(
            (item) => item.id === reference.id.slice(0, index),
          );

          if (element?.type === "markdown")
            element.markdown = element.markdown.replaceAll(
              reference.id.slice(index + 1),
              `review-source:head/${encodeURI(mapped.file)}#L${mapped.fromLine}-L${mapped.toLine}`,
            );
        } else Object.assign(reference.source, mapped);
      } catch (error) {
        if (!(error instanceof ReviewInputError)) throw error;
        projected.staleSources.push(reference.id);
      }
    }

    projected.pins = pins;

    return projected;
  }
  sourcePins(snapshot: Snapshot, generation?: string): Pins {
    if (!generation) return snapshot.pins;

    if (snapshot.target?.kind !== "worktree")
      throw new ReviewInputError(
        "Committed targets have no working source generation.",
      );
    const resource = this.store.resource(generation);

    if (resource.repositoryId !== snapshot.pins.repositoryId)
      throw new ReviewInputError("Source belongs to another repository.");
    const source = retainedWorktree(this.store, generation);

    return {
      repositoryId: snapshot.pins.repositoryId,
      base: snapshot.target.base ?? source.commit,
      head: source.commit,
      sourceGeneration: generation,
    };
  }
  async resolveTarget(
    target: ReviewTarget,
  ): Promise<{ target: ReviewTarget; pins: Pins }> {
    const vcs = await this.vcs(target.repositoryId);

    if (!vcs)
      throw new ReviewInputError(
        "The selected local checkout is unavailable.",
        404,
      );

    if (target.kind === "commits") {
      const head = await vcs.resolveRevision(target.head);

      if (!head) throw new ReviewInputError("Head revision does not exist.");

      const base =
        target.base === undefined
          ? head
          : await vcs.resolveRevision(target.base);

      if (!base) throw new ReviewInputError("Base revision does not exist.");

      const resolved = { ...target, head: head.commit };

      if (target.base !== undefined) resolved.base = base.commit;

      return {
        target: resolved,
        pins: {
          repositoryId: target.repositoryId,
          base: base.commit,
          head: head.commit,
        },
      };
    }

    const base =
      target.base === undefined
        ? undefined
        : await vcs.resolveRevision(target.base);

    if (target.base !== undefined && !base)
      throw new ReviewInputError("Base revision does not exist.");
    const { generation, source } = await this.capture(target.repositoryId, vcs);

    const resolved = { ...target };

    if (base) resolved.base = base.commit;

    return {
      target: resolved,
      pins: {
        repositoryId: target.repositoryId,
        base: base?.commit ?? source.commit,
        head: source.commit,
        sourceGeneration: generation,
      },
    };
  }
  async resolvePins(
    repositoryId: string,
    base: string,
    head: string,
  ): Promise<Pins> {
    const vcs = await this.vcs(repositoryId);

    const [left, right] = vcs
      ? await Promise.all([
          vcs.resolveRevision(base),
          vcs.resolveRevision(head),
        ])
      : [null, null];

    if (!left || !right)
      throw new ReviewInputError("Base or head revision does not exist.");

    return { repositoryId, base: left.commit, head: right.commit };
  }
  async validatePins(pins: Pins) {
    if (pins.sourceGeneration) {
      const resource = this.store.resource(pins.sourceGeneration);

      if (
        resource.repositoryId !== pins.repositoryId ||
        resource.kind !== "source-tree"
      )
        throw new ReviewInputError("Source belongs to another repository.");

      return;
    }

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
  async file(
    pins: Pins,
    side: "base" | "head",
    file: string,
    allowBinary = false,
  ) {
    checkRelativePath(file);
    const commit = pins[side];
    const vcs = await this.vcs(pins.repositoryId);

    const retained =
      pins.sourceGeneration && side === "head"
        ? retainedWorktree(this.store, pins.sourceGeneration).files[file]
        : undefined;

    if (
      retained?.error &&
      !(allowBinary && (retained.blob || retained.committed))
    )
      throw new ReviewInputError(retained.error);

    const text =
      pins.sourceGeneration && side === "head" && !retained?.committed
        ? retained?.blob
          ? Buffer.from(this.store.resource(retained.blob).data).toString()
          : null
        : commit === EMPTY_SOURCE
          ? null
          : vcs
            ? await readFileAtCommit({
                rootPath: vcs.rootPath,
                kind: vcs.kind,
                commit,
                relativePath: file,
                reader: this.reader(pins.repositoryId, vcs),
              })
            : null;

    if (text === null)
      throw new ReviewInputError(
        "File is unavailable at the pinned commit.",
        404,
      );

    if (!allowBinary && text.includes("\0"))
      throw new ReviewInputError(
        "Binary files cannot be used as code references.",
      );

    return { file, side, commit, text };
  }

  async tree(
    pins: Pins,
    side: "base" | "head",
    directory: string,
  ): Promise<ReviewSourceEntry[]> {
    inputError(() => checkSourcePath(directory));
    const prefix = directory ? directory.replace(/\/$/, "") + "/" : "";
    const entries = new Map<string, ReviewSourceEntry>();

    const files =
      pins.sourceGeneration && side === "head"
        ? Object.keys(retainedWorktree(this.store, pins.sourceGeneration).files)
        : pins[side] === EMPTY_SOURCE
          ? []
          : await this.trackedFilesAt(pins.repositoryId, pins[side]);

    for (const file of files) {
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
    const key = `${repositoryId}\0${ref}`;
    let files = this.trackedFiles.get(key);

    if (!files) {
      files = this.vcs(repositoryId).then((vcs) => {
        // Do not keep the empty listing of a missing repository.
        if (!vcs) {
          this.trackedFiles.delete(key);

          return [];
        }

        return listTrackedFilesAtCommit({
          rootPath: vcs.rootPath,
          kind: vcs.kind,
          commit: ref,
        });
      });
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
  /** Legacy import keeps a document whose source ranges no longer resolve;
   * the problem becomes a warning instead of a rejection. */
  async validateSourceTolerant(
    pins: Pins,
    source: Source,
    options: { peek: boolean },
  ): Promise<string | null> {
    try {
      await this.validateSource(pins, source, options);

      return null;
    } catch (error) {
      if (error instanceof ReviewInputError)
        return `${source.side}/${source.file}#L${source.fromLine}-L${source.toLine}: ${error.message}`;
      throw error;
    }
  }
  private readonly catalogStats = new Map<string, Promise<void>>();

  /** Hydrate immutable source statistics once per pin pair, without delaying Home. */
  populateCatalogStats(): Promise<void> {
    if (this.closed) return Promise.resolve();

    return Promise.all(
      this.store.list().map((review) => {
        const key = JSON.stringify(review.pins);
        let pending = this.catalogStats.get(key);

        if (!pending) {
          pending = this.changes(review.pins)
            .then((files) => {
              if (this.closed) return;
              this.store.setDiffStats(review.pins, {
                fileCount: files.length,
                additions: files.reduce((sum, file) => sum + file.additions, 0),
                deletions: files.reduce((sum, file) => sum + file.deletions, 0),
              });
            })
            .catch(() => {
              /* An unavailable checkout leaves counts unknown, never zero. */
            });
          this.catalogStats.set(key, pending);
        }

        return pending;
      }),
    ).then(() => {});
  }

  changes(pins: Pins): Promise<LocalVcsDiffFileSummary[]>;
  changes(pins: Pins, file: string): Promise<string>;
  changes(
    pins: Pins,
    file?: string,
  ): Promise<LocalVcsDiffFileSummary[] | string>;
  async changes(pins: Pins, file?: string) {
    if (file !== undefined) checkRelativePath(file);

    if (pins.sourceGeneration) {
      const head = retainedWorktree(this.store, pins.sourceGeneration);

      const committedChanges =
        pins.base === pins.head ||
        pins.base === EMPTY_SOURCE ||
        pins.head === EMPTY_SOURCE
          ? []
          : await diffFileSummariesTrees({
              ...(await this.vcsTarget(pins.repositoryId)),
              baseRef: pins.base,
              headRef: pins.head,
            });

      const currentFiles =
        pins.head === EMPTY_SOURCE
          ? []
          : await this.trackedFilesAt(pins.repositoryId, pins.head);

      const paths =
        file === undefined
          ? [
              ...new Set([
                ...committedChanges.flatMap((change) =>
                  change.previousPath
                    ? [change.previousPath, change.path]
                    : [change.path],
                ),
                ...Object.keys(head.files).filter(
                  (path) =>
                    !head.files[path]?.committed || pins.base === EMPTY_SOURCE,
                ),
                ...currentFiles.filter(
                  (path) => !Object.hasOwn(head.files, path),
                ),
              ]),
            ]
          : [file];

      const result: (LocalVcsDiffFileSummary & { patch: string })[] = [];

      for (const path of paths) {
        if (head.files[path]?.committed && pins.base === pins.head) continue;

        if (
          head.files[path]?.error &&
          !head.files[path]?.blob &&
          !head.files[path]?.committed
        ) {
          result.push({
            path,
            status: "modified",
            additions: 0,
            deletions: 0,
            patch: `Source unavailable: ${head.files[path]!.error}\n`,
          });
          continue;
        }

        const read = async (side: "base" | "head") => {
          try {
            return (await this.file(pins, side, path, true)).text;
          } catch (error) {
            if (error instanceof ReviewInputError && error.status === 404)
              return null;
            throw error;
          }
        };

        const [before, after] = await Promise.all([read("base"), read("head")]);
        const change = await sourceDiff(path, before, after);

        if (change) result.push(change);
      }

      return file === undefined ? result : (result[0]?.patch ?? "");
    }

    const input = {
      ...(await this.vcsTarget(pins.repositoryId)),
      baseRef: pins.base,
      headRef: pins.head,
    };

    return file === undefined
      ? diffFileSummariesTrees(input)
      : diffTrees({ ...input, paths: [file], literalPaths: true });
  }
  commits(pins: Pins) {
    if (
      pins.base === pins.head ||
      pins.base === EMPTY_SOURCE ||
      pins.head === EMPTY_SOURCE
    )
      return Promise.resolve([]);
    const key = `${pins.repositoryId}:${pins.base}:${pins.head}`;
    const cached = this.commitRanges.get(key);

    if (cached) return cached;

    // Immutable pins: one list per key; a rejection is evicted.
    const pending = this.readCommitRange(pins).catch((cause: unknown) => {
      this.commitRanges.delete(key);

      throw cause;
    });

    this.commitRanges.set(key, pending);

    return pending;
  }
  private async readCommitRange(pins: Pins) {
    return listCommitRange({
      ...(await this.vcsTarget(pins.repositoryId)),
      baseRef: pins.base,
      headRef: pins.head,
    });
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

    return {
      repositoryId: pins.repositoryId,
      base: selected.parentCommit,
      head: selected.commit,
    };
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

    const target = await this.vcsTarget(pins.repositoryId);

    const changes = pins.sourceGeneration
      ? await this.changes(pins)
      : undefined;

    const patch = changes
      ? (
          await Promise.all(
            changes.map((change) => this.changes(pins, change.path)),
          )
        ).join("\n")
      : undefined;

    const resolved = await resolveSoftwareMapDiffCounts({
      patch,
      sourceRootPath: target.rootPath,
      sourceVcsKind: target.kind,
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
      case "image":
        data = await decodeImage(Buffer.from(input.base64, "base64"));
        mimeType = "image/png";
        break;

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

      const event = trace.events.find((event) => event.id === block.eventId);

      if (!event || !textIncludesQuote(event.text, block.text))
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

export function openLocalReviewStore(
  databasePath: string,
  options: { blobReaderIdleTimeoutMs?: number } = {},
) {
  const store: ReviewStore = new ReviewStore(databasePath, {
    projectSource: (snapshot, pins) => data.projectSource(snapshot, pins),
    resolveTarget: (target) => data.resolveTarget(target),
    validatePins: (pins) => data.validatePins(pins),
    validateSource: (pins, source, options) =>
      data.validateSource(pins, source, options),
    validateResource: (pins, block) => data.validateResource(pins, block),
    validateSourceTolerant: (pins, source, options) =>
      data.validateSourceTolerant(pins, source, options),
  });

  const data = new LocalReviewData(store, {
    ...options,
    workspaceDatabase: `${databasePath}.workspaces`,
  });

  return { store, data };
}
