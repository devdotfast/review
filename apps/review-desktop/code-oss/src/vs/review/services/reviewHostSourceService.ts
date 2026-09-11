/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../base/common/event.js";
import { Disposable, type IDisposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { DefaultLinesDiffComputer } from "../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import {
  FilePermission, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType,
  IFileService, createFileSystemProviderError,
  type IFileSystemProviderWithFileReadWriteCapability, type IStat,
} from "../../platform/files/common/files.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { HOST_SOURCE_QUERIES, HostIdSchema, ReviewClient, type HostQueryInputs, type HostQueryResults, type ReviewHostSourceTarget, type ReviewRangeWire, type ReviewInlineEditorFactory, type ReviewInlineEditorRange, type ReviewCommitScope, type ReviewDiffFileWire } from "../common/reviewProtocol.js";
import { reviewPeekWindows, reviewPeekDiffWindows, type ReviewPeekLineMapping } from "../common/reviewPeek.js";
import type { ReviewCodeModelReference, ReviewCodeDiffTarget } from "./reviewCodeResourceService.js";
import { IReviewSessionService } from "./reviewSessionService.js";
import type { ReviewInlineEditorService } from "./reviewInlineEditorService.js";
import type { ReviewDiffViewSource } from "./reviewDiffViewService.js";

export interface ReviewHostCanvasSource {
  readonly inlineEditors: ReviewInlineEditorFactory;
  readonly diffViewSource: ReviewDiffViewSource;
}

export const REVIEW_HOST_SOURCE_SCHEME = "review-host-source";
export const IReviewHostSourceService = createDecorator<IReviewHostSourceService>("reviewHostSourceService");
export interface IReviewHostSourceService {
  readonly _serviceBrand: undefined;
  openSource(target: ReviewHostSourceTarget): Promise<void>;
  acquireSnippet(target: ReviewHostSourceTarget): Promise<ReviewCodeModelReference>;
  requestComment(resource: URI, range: ReviewRangeWire): Promise<void>;
  subscribeComments(reviewId: string, listener: (target: ReviewHostSourceTarget) => void, reviewVersion?: () => number): IDisposable;
  createCanvasSource(reviewId: string, reviewVersion: () => number, inlineEditors: ReviewInlineEditorService): ReviewHostCanvasSource;
  sourceRoot(reviewId: string, reviewVersion: number): Promise<URI>;
}

interface HostSourceLocation {
  hostId: string;
  workspaceId: string;
  request: HostQueryInputs["source.read"];
}

/** Identity contains immutable review version, never a token or local path. */
export function hostSourceUri(hostId: string, workspaceId: string, request: HostQueryInputs["source.read"]): URI {
  request = HOST_SOURCE_QUERIES["source.read"].input.parse(request);
  const query = new URLSearchParams({ workspaceId: HostIdSchema.parse(workspaceId), reviewId: request.reviewId, reviewVersion: String(request.reviewVersion), side: request.side });
  if (request.comparisonCommit) query.set("comparisonCommit", request.comparisonCommit);
  return URI.from({ scheme: REVIEW_HOST_SOURCE_SCHEME, authority: HostIdSchema.parse(hostId), path: `/${request.file}`,
    query: query.toString() });
}

export function parseHostSourceUri(resource: URI): HostSourceLocation {
  if (resource.scheme !== REVIEW_HOST_SOURCE_SCHEME) throw new Error("This is not a Review source resource.");
  const query = new URLSearchParams(resource.query);
  if (!query.has("reviewVersion")) throw new Error("Review source review version is missing.");
  return { hostId: HostIdSchema.parse(resource.authority), workspaceId: HostIdSchema.parse(query.get("workspaceId")),
    request: HOST_SOURCE_QUERIES["source.read"].input.parse({ reviewId: query.get("reviewId"), reviewVersion: Number(query.get("reviewVersion")), side: query.get("side"), file: resource.path.slice(1), ...(query.has("comparisonCommit") ? { comparisonCommit: query.get("comparisonCommit") } : {}) }) };
}

/** Native read-only files backed exclusively by the authoritative source API. */
export class ReviewHostSourceService extends Disposable implements IReviewHostSourceService, IFileSystemProviderWithFileReadWriteCapability {
  declare readonly _serviceBrand: undefined;
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive | FileSystemProviderCapabilities.Readonly;
  readonly onDidChangeCapabilities = Event.None;
  readonly onDidChangeFile = Event.None;
  private connection: { serverUrl: string; token: string; client: Promise<ReviewClient> } | undefined;
  private readonly commentRequested = this._register(new Emitter<ReviewHostSourceTarget>());
  private readonly pendingComments = new Map<string, ReviewHostSourceTarget>();

  constructor(
    @IReviewSessionService private readonly sessionService: IReviewSessionService,
    @IFileService fileService: IFileService,
    @ITextModelService private readonly modelService: ITextModelService,
    @IEditorService private readonly editorService: IEditorService,
  ) {
    super();
    this._register(fileService.registerProvider(REVIEW_HOST_SOURCE_SCHEME, this));
  }

  private async client(): Promise<ReviewClient> {
    const connection = await this.sessionService.getConnection();
    if (!this.connection || this.connection.serverUrl !== connection.serverUrl || this.connection.token !== connection.token) {
      const pending = { ...connection, client: ReviewClient.connect(connection) };
      this.connection = pending;
      void pending.client.catch(() => { if (this.connection === pending) this.connection = undefined; });
    }
    return this.connection.client;
  }

  private async source(resource: URI) {
    const location = parseHostSourceUri(resource);
    const client = await this.client();
    if (location.hostId !== client.connection.hostId || location.workspaceId !== client.connection.workspaceId)
      throw createFileSystemProviderError("This Review source belongs to another host.", FileSystemProviderErrorCode.Unavailable);
    return { client, request: location.request };
  }

  async sourceRoot(reviewId: string, reviewVersion: number): Promise<URI> {
    const request = HOST_SOURCE_QUERIES["source.tree"].input.parse({ reviewId, reviewVersion, side: "head" });
    const client = await this.client();
    const resource = URI.from({ scheme: REVIEW_HOST_SOURCE_SCHEME, authority: client.connection.hostId, path: "/",
      query: new URLSearchParams({ workspaceId: client.connection.workspaceId, reviewId: request.reviewId, reviewVersion: String(request.reviewVersion), side: request.side }).toString() });
    await this.tree(resource);
    return resource;
  }

  private async tree(resource: URI) {
    const query = new URLSearchParams(resource.query);
    const client = await this.client();
    if (resource.scheme !== REVIEW_HOST_SOURCE_SCHEME || resource.authority !== client.connection.hostId || query.get("workspaceId") !== client.connection.workspaceId)
      throw createFileSystemProviderError("This Review source belongs to another host.", FileSystemProviderErrorCode.Unavailable);
    const request = HOST_SOURCE_QUERIES["source.tree"].input.parse({ reviewId: query.get("reviewId"), reviewVersion: Number(query.get("reviewVersion")),
      side: query.get("side"), directory: resource.path.slice(1) || undefined, comparisonCommit: query.get("comparisonCommit") ?? undefined });
    const entries: HostQueryResults["source.tree"]["items"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.query("source.tree", { ...request, limit: 200, cursor });
      entries.push(...page.result.items);
      cursor = page.result.nextCursor ?? undefined;
    } while (cursor);
    return entries;
  }

  private async resource(target: ReviewHostSourceTarget): Promise<URI> {
    const parsed = sourceTargetRequest(target);
    const client = await this.client();
    return hostSourceUri(client.connection.hostId, client.connection.workspaceId, {
      reviewId: parsed.reviewId, reviewVersion: parsed.reviewVersion, side: parsed.side, file: parsed.file, comparisonCommit: parsed.comparisonCommit,
    });
  }

  async openSource(target: ReviewHostSourceTarget): Promise<void> {
    await this.editorService.openEditor({ resource: await this.resource(target), options: {
      pinned: true, selection: { startLineNumber: target.range.fromLine, startColumn: 1, endLineNumber: target.range.toLine, endColumn: Number.MAX_SAFE_INTEGER },
    } });
  }

  async requestComment(resource: URI, range: ReviewRangeWire): Promise<void> {
    if (new URLSearchParams(resource.query).has("diffAbsent")) throw new Error("The empty side of this diff has no source to comment on.");
    const { request } = await this.source(resource);
    const parsed = HOST_SOURCE_QUERIES["source.read"].input.parse({ ...request, range });
    const target: ReviewHostSourceTarget = {
      reviewId: parsed.reviewId, reviewVersion: parsed.reviewVersion,
      ...(parsed.comparisonCommit ? { comparisonCommit: parsed.comparisonCommit } : {}),
      range: { ...parsed.range!, side: parsed.side, file: parsed.file },
    };
    this.pendingComments.set(request.reviewId, target);
    this.commentRequested.fire(target);
  }

  subscribeComments(reviewId: string, listener: (target: ReviewHostSourceTarget) => void, reviewVersion?: () => number): IDisposable {
    const deliver = (target: ReviewHostSourceTarget) => {
      if (target.reviewId !== reviewId || (reviewVersion && target.reviewVersion !== reviewVersion())) return;
      this.pendingComments.delete(reviewId);
      listener(target);
    };
    const subscription = this.commentRequested.event(deliver);
    const pending = this.pendingComments.get(reviewId);
    if (pending) deliver(pending);
    return subscription;
  }

  async acquireSnippet(target: ReviewHostSourceTarget): Promise<ReviewCodeModelReference> {
    const parsed = sourceTargetRequest(target);
    return this.acquireRanges({ reviewId: parsed.reviewId, reviewVersion: parsed.reviewVersion, side: parsed.side, file: parsed.file, comparisonCommit: parsed.comparisonCommit },
      [{ startLine: parsed.range!.fromLine, endLine: parsed.range!.toLine }]);
  }

  private async acquireRanges(request: HostQueryInputs["source.read"], ranges: readonly ReviewInlineEditorRange[]): Promise<ReviewCodeModelReference> {
    const client = await this.client();
    const resource = hostSourceUri(client.connection.hostId, client.connection.workspaceId, request);
    const reference = await this.modelService.createModelReference(resource);
    const model = reference.object.textEditorModel;
    if (!model || ranges.some(range => !Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine || range.endLine > model.getLineCount())) {
      reference.dispose();
      throw new Error("The retained source range is unavailable in the pinned file.");
    }
    return { model, target: { resource, workingTreeFallback: false },
      windows: reviewPeekWindows(model.getLineCount(), ranges, "content"),
      dispose: () => reference.dispose() };
  }

  /** Uses the original native editors/tree. Only their source-data boundary changes. */
  createCanvasSource(reviewId: string, reviewVersion: () => number, inlineEditors: ReviewInlineEditorService): ReviewHostCanvasSource {
    HostIdSchema.parse(reviewId);
    const version = () => ({ reviewId, reviewVersion: reviewVersion() });
    const files = async (request: HostQueryInputs["source.diff"]): Promise<readonly ReviewDiffFileWire[]> => {
      const client = await this.client();
      const result: ReviewDiffFileWire[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.query("source.diff", { ...request, limit: 200, cursor });
        result.push(...page.result.items.map(file => ({ path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}), status: file.status, additions: file.additions, deletions: file.deletions })));
        cursor = page.result.nextCursor ?? undefined;
      } while (cursor);
      return result;
    };
    const diff = async (request: HostQueryInputs["source.read"], ranges: readonly ReviewInlineEditorRange[]): Promise<ReviewCodeDiffTarget | undefined> => {
      const changedFiles = await files({ reviewId, reviewVersion: request.reviewVersion, comparisonCommit: request.comparisonCommit });
      const file = changedFiles.find(file => (request.side === "base" ? file.previousPath ?? file.path : file.path) === request.file);
      if (!file) return undefined;
      if ((file.status === "added" && request.side === "base") || (file.status === "deleted" && request.side === "head")) throw new Error("The requested source side is absent from the pinned change.");
      const client = await this.client();
      const uri = (side: "base" | "head", path: string, absent: boolean) => {
        const resource = hostSourceUri(client.connection.hostId, client.connection.workspaceId, { ...request, side, file: path });
        return absent ? resource.with({ query: `${resource.query}&diffAbsent=1` }) : resource;
      };
      const original = uri("base", file.previousPath ?? file.path, file.status === "added");
      const modified = uri("head", file.path, file.status === "deleted");
      const originalReference = await this.modelService.createModelReference(original);
      try {
        const modifiedReference = await this.modelService.createModelReference(modified);
        try {
          const originalModel = originalReference.object.textEditorModel;
          const modifiedModel = modifiedReference.object.textEditorModel;
          const mappings = hostSourceDiffMappings(originalModel.getLinesContent(), modifiedModel.getLinesContent());
          return { original, modified, diffFile: file, mappings, windows: (originalLineCount, modifiedLineCount) => reviewPeekDiffWindows(originalLineCount, modifiedLineCount, ranges, request.side, mappings) };
        } finally { modifiedReference.dispose(); }
      } finally { originalReference.dispose(); }
    };
    return {
      inlineEditors: {
        create: spec => {
          const request = { ...version(), side: spec.side, file: spec.path };
          return inlineEditors.create(spec, () => this.acquireRanges(request, spec.ranges), () => diff(request, spec.ranges));
        },
        find: (spec, query) => {
          const request = { ...version(), side: spec.side, file: spec.path };
          return inlineEditors.find(spec, query, () => this.acquireRanges(request, spec.ranges), () => diff(request, spec.ranges));
        },
      },
      diffViewSource: {
        files: (scope?: ReviewCommitScope) => files({ ...version(), comparisonCommit: scope?.commit }),
        load: async (scope?: ReviewCommitScope) => {
          // Capture once: a concurrent live commit must not mix identity and content.
          const request = { ...version(), comparisonCommit: scope?.commit };
          const [client, changedFiles] = await Promise.all([this.client(), files(request)]);
          const { hostId, workspaceId } = client.connection;
          const query = new URLSearchParams({ workspaceId, reviewVersion: String(request.reviewVersion) });
          if (request.comparisonCommit) query.set("comparisonCommit", request.comparisonCommit);
          return {
            sourceUri: URI.from({ scheme: "devfast-review-files", authority: hostId, path: `/${reviewId}`, query: query.toString() }),
            entries: changedFiles.map(file => {
              const original = file.status === "added" ? undefined : hostSourceUri(hostId, workspaceId, { ...request, side: "base", file: file.previousPath ?? file.path });
              const modified = file.status === "deleted" ? undefined : hostSourceUri(hostId, workspaceId, { ...request, side: "head", file: file.path });
              return { file, original, modified, goToFileResource: (modified ?? original)! };
            }),
          };
        },
      },
    };
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const { client, request } = await this.source(resource);
    if (new URLSearchParams(resource.query).has("diffAbsent")) {
      await this.requireAbsentSide(client, request);
      return new Uint8Array();
    }
    const { result } = await client.query("source.read", request);
    return new TextEncoder().encode(result.text);
  }

  async stat(resource: URI): Promise<IStat> {
    if (new URLSearchParams(resource.query).has("diffAbsent")) {
      const { client, request } = await this.source(resource);
      await this.requireAbsentSide(client, request);
      return { type: FileType.File, size: 0, ctime: 0, mtime: 0, permissions: FilePermission.Readonly };
    }
    if (resource.path === "/") {
      await this.tree(resource);
      return { type: FileType.Directory, size: 0, ctime: 0, mtime: 0, permissions: FilePermission.Readonly };
    }
    const slash = resource.path.lastIndexOf("/");
    const parent = resource.with({ path: resource.path.slice(0, slash) || "/" });
    const entry = (await this.tree(parent)).find(entry => entry.path === resource.path.slice(1));
    if (!entry) throw createFileSystemProviderError("The pinned source entry does not exist.", FileSystemProviderErrorCode.FileNotFound);
    return { type: sourceEntryType(entry.kind), size: entry.byteLength ?? 0, ctime: 0, mtime: 0, permissions: FilePermission.Readonly };
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    return (await this.tree(resource)).map(entry => [entry.path.slice(entry.path.lastIndexOf("/") + 1), sourceEntryType(entry.kind)]);
  }

  private async requireAbsentSide(client: ReviewClient, request: HostQueryInputs["source.read"]): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await client.query("source.diff", { reviewId: request.reviewId, reviewVersion: request.reviewVersion, comparisonCommit: request.comparisonCommit, cursor, limit: 200 });
      if (page.result.items.some(file => file.path === request.file && ((request.side === "base" && file.status === "added") || (request.side === "head" && file.status === "deleted")))) return;
      cursor = page.result.nextCursor ?? undefined;
    } while (cursor);
    throw createFileSystemProviderError("The requested diff side is not absent.", FileSystemProviderErrorCode.FileNotFound);
  }

  watch(): IDisposable { return Disposable.None; }
  async writeFile(): Promise<void> { throw hostSourceReadonly(); }
  async mkdir(): Promise<void> { throw hostSourceReadonly(); }
  async delete(): Promise<void> { throw hostSourceReadonly(); }
  async rename(): Promise<void> { throw hostSourceReadonly(); }
}

/** The native selection keeps side/file together; the public read API is flat. */
function sourceTargetRequest(target: ReviewHostSourceTarget) {
  const { range, ...identity } = target;
  return HOST_SOURCE_QUERIES["source.read"].input.parse({
    ...identity, side: range.side, file: range.file,
    range: { fromLine: range.fromLine, toLine: range.toLine },
  });
}

function hostSourceReadonly(): Error {
  return createFileSystemProviderError("Review source files are read-only.", FileSystemProviderErrorCode.NoPermissions);
}

function sourceEntryType(kind: "file" | "directory" | "symlink" | "submodule"): FileType {
  return kind === "directory" ? FileType.Directory : kind === "symlink" ? FileType.SymbolicLink : FileType.File;
}

/** The native peek's line windows use the same bounded line-diff engine as Monaco. */
export function hostSourceDiffMappings(originalLines: string[], modifiedLines: string[]): ReviewPeekLineMapping[] {
  const result = new DefaultLinesDiffComputer().computeDiff(originalLines, modifiedLines, { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 1_000 });
  if (result.hitTimeout) throw new Error("The source diff exceeded the native preview's computation limit.");
  return result.changes.map(change => ({ originalStartLine: change.original.startLineNumber, originalEndLineExclusive: change.original.endLineNumberExclusive,
    modifiedStartLine: change.modified.startLineNumber, modifiedEndLineExclusive: change.modified.endLineNumberExclusive }));
}
