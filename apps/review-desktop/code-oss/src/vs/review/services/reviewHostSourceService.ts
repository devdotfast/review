/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../base/common/event.js";
import { Disposable, type IDisposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import {
  FilePermission, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType,
  IFileService, createFileSystemProviderError,
  type IFileSystemProviderWithFileReadWriteCapability, type IStat,
} from "../../platform/files/common/files.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { HOST_SOURCE_QUERIES, HostIdSchema, ReviewClient, type HostQueryInputs, type ReviewHostSourceTarget, type ReviewRangeWire } from "../common/reviewProtocol.js";
import { reviewPeekWindows } from "../common/reviewPeek.js";
import type { ReviewCodeModelReference } from "./reviewCodeResourceService.js";
import { IReviewSessionService } from "./reviewSessionService.js";

export const REVIEW_HOST_SOURCE_SCHEME = "review-host-source";
export const IReviewHostSourceService = createDecorator<IReviewHostSourceService>("reviewHostSourceService");
export interface IReviewHostSourceService {
  readonly _serviceBrand: undefined;
  openSource(target: ReviewHostSourceTarget): Promise<void>;
  acquireSnippet(target: ReviewHostSourceTarget): Promise<ReviewCodeModelReference>;
  requestComment(resource: URI, range: ReviewRangeWire): Promise<void>;
  subscribeComments(reviewId: string, listener: (target: ReviewHostSourceTarget) => void): IDisposable;
}

interface HostSourceLocation {
  hostId: string;
  workspaceId: string;
  request: HostQueryInputs["source.file"];
}

/** Identity contains immutable document version, never a token or local path. */
export function hostSourceUri(hostId: string, workspaceId: string, request: HostQueryInputs["source.file"]): URI {
  request = HOST_SOURCE_QUERIES["source.file"].input.parse(request);
  return URI.from({ scheme: REVIEW_HOST_SOURCE_SCHEME, authority: HostIdSchema.parse(hostId), path: `/${request.file}`,
    query: new URLSearchParams({ workspaceId: HostIdSchema.parse(workspaceId), reviewId: request.reviewId, documentVersion: String(request.documentVersion), side: request.side }).toString() });
}

export function parseHostSourceUri(resource: URI): HostSourceLocation {
  if (resource.scheme !== REVIEW_HOST_SOURCE_SCHEME) throw new Error("This is not a Review source resource.");
  const query = new URLSearchParams(resource.query);
  if (!query.has("documentVersion")) throw new Error("Review source document version is missing.");
  return { hostId: HostIdSchema.parse(resource.authority), workspaceId: HostIdSchema.parse(query.get("workspaceId")),
    request: HOST_SOURCE_QUERIES["source.file"].input.parse({ reviewId: query.get("reviewId"), documentVersion: Number(query.get("documentVersion")), side: query.get("side"), file: resource.path.slice(1) }) };
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

  private async resource(target: ReviewHostSourceTarget): Promise<URI> {
    const parsed = HOST_SOURCE_QUERIES["source.read"].input.parse(target);
    const client = await this.client();
    return hostSourceUri(client.connection.hostId, client.connection.workspaceId, {
      reviewId: parsed.reviewId, documentVersion: parsed.documentVersion, side: parsed.range.side, file: parsed.range.file,
    });
  }

  async openSource(target: ReviewHostSourceTarget): Promise<void> {
    await this.editorService.openEditor({ resource: await this.resource(target), options: {
      pinned: true, selection: { startLineNumber: target.range.fromLine, startColumn: 1, endLineNumber: target.range.toLine, endColumn: Number.MAX_SAFE_INTEGER },
    } });
  }

  async requestComment(resource: URI, range: ReviewRangeWire): Promise<void> {
    const { request } = await this.source(resource);
    const target = HOST_SOURCE_QUERIES["source.read"].input.parse({ reviewId: request.reviewId, documentVersion: request.documentVersion, range: { ...range, side: request.side, file: request.file } });
    this.pendingComments.set(request.reviewId, target);
    this.commentRequested.fire(target);
  }

  subscribeComments(reviewId: string, listener: (target: ReviewHostSourceTarget) => void): IDisposable {
    const deliver = (target: ReviewHostSourceTarget) => {
      if (target.reviewId !== reviewId) return;
      this.pendingComments.delete(reviewId);
      listener(target);
    };
    const subscription = this.commentRequested.event(deliver);
    const pending = this.pendingComments.get(reviewId);
    if (pending) deliver(pending);
    return subscription;
  }

  async acquireSnippet(target: ReviewHostSourceTarget): Promise<ReviewCodeModelReference> {
    const resource = await this.resource(target);
    const reference = await this.modelService.createModelReference(resource);
    const model = reference.object.textEditorModel;
    if (!model || target.range.toLine > model.getLineCount()) {
      reference.dispose();
      throw new Error("The retained source range is unavailable in the pinned file.");
    }
    return { model, target: { resource, workingTreeFallback: false },
      windows: reviewPeekWindows(model.getLineCount(), [{ startLine: target.range.fromLine, endLine: target.range.toLine }], "content"),
      dispose: () => reference.dispose() };
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const { client, request } = await this.source(resource);
    const { result } = await client.query("source.file", request);
    return new TextEncoder().encode(result.text);
  }

  async stat(resource: URI): Promise<IStat> {
    const bytes = await this.readFile(resource);
    return { type: FileType.File, size: bytes.byteLength, ctime: 0, mtime: 0, permissions: FilePermission.Readonly };
  }

  async readdir(): Promise<[string, FileType][]> {
    throw createFileSystemProviderError("Review source resources are files, not folders.", FileSystemProviderErrorCode.FileNotADirectory);
  }

  watch(): IDisposable { return Disposable.None; }
  async writeFile(): Promise<void> { throw hostSourceReadonly(); }
  async mkdir(): Promise<void> { throw hostSourceReadonly(); }
  async delete(): Promise<void> { throw hostSourceReadonly(); }
  async rename(): Promise<void> { throw hostSourceReadonly(); }
}

function hostSourceReadonly(): Error {
  return createFileSystemProviderError("Review source files are read-only.", FileSystemProviderErrorCode.NoPermissions);
}
