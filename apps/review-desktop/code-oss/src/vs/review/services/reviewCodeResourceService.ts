/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IReference } from "../../base/common/lifecycle.js";
import { extUri } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import type { ITextModel } from "../../editor/common/model.js";
import { IModelService } from "../../editor/common/services/model.js";
import {
  ITextModelService,
  type IResolvedTextEditorModel,
} from "../../editor/common/services/resolverService.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import {
  REVIEW_BASE_SCHEME,
  REVIEW_HEAD_SCHEME,
  REVIEW_UNIFIED_SCHEME,
  reviewBaseFileUri,
  reviewFileUri,
  reviewHeadFileUri,
  reviewVirtualUri,
} from "../common/reviewCodeResources.js";
import {
  buildReviewUnifiedDiff,
  reviewDiffPositionRowsForRange,
  reviewDiffSideRangeForPositionRows,
  reviewUnifiedPositionRowsForRange,
  reviewUnifiedRangeForPositionRows,
  reviewUnifiedRangeForTarget,
  reviewUnifiedRangesForSelections,
  reviewUnifiedTargetForRange,
  reviewUnifiedWindows,
  type ReviewUnifiedDiffRow,
  type ReviewUnifiedLineRange,
} from "../common/reviewUnifiedDiff.js";
export {
  REVIEW_BASE_SCHEME,
  REVIEW_HEAD_SCHEME,
  reviewBaseFileUri,
  reviewFileUri,
  reviewHeadFileUri,
  reviewResourceIdentity,
  reviewVirtualUri,
} from "../common/reviewCodeResources.js";
import {
  reviewPeekDiffWindows,
  reviewPeekLineMappings,
  reviewPeekSideAvailable,
  reviewPeekWindows,
  type ReviewPeekLineMapping,
  type ReviewPeekWindow,
} from "../common/reviewPeek.js";
import type {
  GitLabDiffPosition,
  GitLabTextDiffRow,
  ReviewCommitScope,
  ReviewDiffFileWire,
  ReviewDiffSide,
  ReviewInlineEditorRange,
} from "../common/reviewProtocol.js";
import {
  gitLabDiffPositionRows,
  parseReviewDiffFilesResponse,
  parseReviewFileContentResponse,
} from "../common/reviewProtocol.js";
import {
  reviewDiffFileForReveal,
  reviewDiffFilesUrl,
} from "../common/reviewReveal.js";
import {
  IReviewSessionModelService,
  type ReviewDesktopSession,
} from "./reviewSessionModelService.js";

export interface ReviewCodeResourceTarget {
  readonly resource: URI;
  readonly diffFile?: ReviewDiffFileWire;
  readonly workingTreeFallback: boolean;
}

export interface ReviewCodeModelReference {
  readonly model: ITextModel;
  readonly target: ReviewCodeResourceTarget;
  readonly windows: readonly ReviewPeekWindow[];
  dispose(): void;
}

export interface ReviewCodeDiffTarget {
  readonly original: URI;
  readonly modified: URI;
  readonly diffFile: ReviewDiffFileWire;
  readonly mappings: readonly ReviewPeekLineMapping[];
  windows(
    originalLineCount: number,
    modifiedLineCount: number,
  ): {
    readonly original: readonly ReviewPeekWindow[];
    readonly modified: readonly ReviewPeekWindow[];
  };
}

export interface ReviewCodePositionRows {
  readonly diffFile: ReviewDiffFileWire;
  readonly start: GitLabTextDiffRow;
  readonly end: GitLabTextDiffRow;
}

export interface ReviewUnifiedResourceInfo {
  readonly path: string;
  readonly diffFile: ReviewDiffFileWire;
  readonly rows: readonly ReviewUnifiedDiffRow[];
  readonly commentingRanges: readonly ReviewUnifiedLineRange[];
  targetForRange(
    startLine: number,
    endLine: number,
  ): {
    readonly path: string;
    readonly side: ReviewDiffSide;
    readonly startLine: number;
    readonly endLine: number;
  } | null;
  rangeForTarget(
    side: ReviewDiffSide,
    startLine: number,
    endLine: number,
  ): ReviewUnifiedLineRange | undefined;
  positionRowsForRange(
    startLine: number,
    endLine: number,
  ): { readonly start: GitLabTextDiffRow; readonly end: GitLabTextDiffRow } | null;
  rangeForPositionRows(
    start: GitLabTextDiffRow,
    end: GitLabTextDiffRow,
  ): ReviewUnifiedLineRange | undefined;
}

export interface ReviewUnifiedCodeModelReference {
  readonly model: ITextModel;
  readonly target: ReviewCodeDiffTarget;
  readonly rows: readonly ReviewUnifiedDiffRow[];
  readonly windows: readonly ReviewPeekWindow[];
  readonly ranges: readonly ReviewUnifiedLineRange[];
  dispose(): void;
}

interface ReviewUnifiedResourceEntry {
  readonly model: ITextModel;
  readonly info: ReviewUnifiedResourceInfo;
  readonly rows: readonly ReviewUnifiedDiffRow[];
  readonly originalLineCount: number;
  readonly modifiedLineCount: number;
  references: number;
  dispose(): void;
}

export const IReviewCodeResourceService =
  createDecorator<IReviewCodeResourceService>("reviewCodeResourceService");

export interface IReviewCodeResourceService {
  readonly _serviceBrand: undefined;
  files(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]>;
  target(
    path: string,
    side: ReviewDiffSide,
    scope?: ReviewCommitScope,
  ): Promise<ReviewCodeResourceTarget>;
  acquireSnippet(
    path: string,
    side: ReviewDiffSide,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewCodeModelReference>;
  resolveDiff(
    path: string,
    side: ReviewDiffSide,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewCodeDiffTarget | undefined>;
  positionRowsForResourceRange(
    resource: URI,
    startLine: number,
    endLine: number,
  ): Promise<ReviewCodePositionRows | null>;
  projectPosition(
    position: GitLabDiffPosition,
    resource: URI,
  ): Promise<ReviewUnifiedLineRange | undefined>;
  acquireUnifiedDiff(
    path: string,
    side: ReviewDiffSide,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewUnifiedCodeModelReference | undefined>;
  unifiedResource(resource: URI): ReviewUnifiedResourceInfo | undefined;
  reset(): void;
}

export class ReviewCodeResourceService
  extends Disposable
  implements IReviewCodeResourceService
{
  declare readonly _serviceBrand: undefined;

  private readonly unavailableSnippetResources = new Set<string>();
  private generation = 0;
  private readonly unifiedResources = new Map<
    string,
    ReviewUnifiedResourceEntry
  >();
  private readonly unifiedResourcesInFlight = new Map<
    string,
    Promise<ReviewUnifiedResourceEntry>
  >();
  private codeRevision: string | undefined;

  constructor(
    @ITextModelService private readonly textModelService: ITextModelService,
    @IModelService private readonly modelService: IModelService,
    @ILanguageService private readonly languageService: ILanguageService,
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
  ) {
    super();
    this.codeRevision = this.currentCodeRevision();
    this._register(
      this.sessionModelService.onDidChangeActiveModel(() => {
        const nextRevision = this.currentCodeRevision();
        if (nextRevision === this.codeRevision) return;
        this.codeRevision = nextRevision;
        this.reset();
      }),
    );
    this._register(
      textModelService.registerTextModelContentProvider(REVIEW_BASE_SCHEME, {
        provideTextContent: (resource) =>
          this.provideDiffContent("base", resource),
      }),
    );
    this._register(
      textModelService.registerTextModelContentProvider(REVIEW_HEAD_SCHEME, {
        provideTextContent: (resource) =>
          this.provideDiffContent("head", resource),
      }),
    );
    this._register(
      textModelService.registerTextModelContentProvider(
        REVIEW_UNIFIED_SCHEME,
        {
          provideTextContent: (resource) =>
            Promise.resolve(this.modelService.getModel(resource)),
        },
      ),
    );
  }

  async target(
    path: string,
    side: ReviewDiffSide,
    scope?: ReviewCommitScope,
  ): Promise<ReviewCodeResourceTarget> {
    return this.targetForSession(this.requireSession(), path, side, scope);
  }

  private async targetForSession(
    session: ReviewDesktopSession,
    path: string,
    side: ReviewDiffSide,
    scope?: ReviewCommitScope,
  ): Promise<ReviewCodeResourceTarget> {
    const files = await this.diffFilesForSession(session, scope);
    if (!files) {
      throw new Error("Review diff metadata is unavailable.");
    }
    const diffFile = reviewDiffFileForReveal(files, path, side);
    if (!diffFile) {
      const pinnedResource = !scope
        ? side === "base"
          ? reviewBaseFileUri(session, path)
          : reviewHeadFileUri(session, path)
        : undefined;
      return {
        resource: pinnedResource ?? reviewFileUri(session, path),
        workingTreeFallback: !pinnedResource,
      };
    }
    const displayPath =
      side === "base"
        ? (diffFile.previousPath ?? diffFile.path)
        : diffFile.path;
    const pinnedResource = !scope
      ? side === "base" && diffFile.status !== "added"
        ? reviewBaseFileUri(session, displayPath)
        : side === "head" && diffFile.status !== "deleted"
          ? reviewHeadFileUri(session, displayPath)
          : undefined
      : undefined;
    return {
      resource:
        pinnedResource ??
        reviewVirtualUri(
          side,
          displayPath,
          diffFile.path,
          session.session.sessionId,
          scope?.commit,
        ),
      diffFile,
      workingTreeFallback: false,
    };
  }

  async files(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]> {
    const files = await this.diffFilesForSession(this.requireSession(), scope);
    if (!files) {
      throw new Error("Review diff metadata is unavailable.");
    }
    return files;
  }

  async acquireSnippet(
    path: string,
    side: ReviewDiffSide,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewCodeModelReference> {
    const target = await this.target(path, side);
    if (!reviewPeekSideAvailable(target.diffFile?.status, side)) {
      throw new Error(`Requested ${side} content is not present: ${path}`);
    }
    const reference = await this.textModelService.createModelReference(
      target.resource,
    );
    const model = reference.object.textEditorModel;
    if (!model) {
      reference.dispose();
      throw new Error(`Native preview could not resolve text content: ${path}`);
    }
    if (this.unavailableSnippetResources.has(target.resource.toString())) {
      reference.dispose();
      throw new Error(`Native preview content is unavailable: ${path}`);
    }
    const windows = reviewPeekWindows(model.getLineCount(), ranges, "content");
    return {
      model,
      target,
      windows,
      dispose: () => reference.dispose(),
    };
  }

  async resolveDiff(
    path: string,
    side: ReviewDiffSide,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewCodeDiffTarget | undefined> {
    const session = this.requireSession();
    const target = await this.targetForSession(session, path, side);
    const diffFile = target.diffFile;
    if (!diffFile) return undefined;

    const [originalTarget, modifiedTarget] = await Promise.all([
      this.targetForSession(
        session,
        diffFile.previousPath ?? diffFile.path,
        "base",
      ),
      this.targetForSession(session, diffFile.path, "head"),
    ]);
    const patch =
      diffFile.patch ??
      (await this.diffPatchForSession(session, diffFile.path));
    if (!patch) return undefined;

    const mappings = reviewPeekLineMappings(patch);
    return {
      original: originalTarget.resource,
      modified: modifiedTarget.resource,
      diffFile,
      mappings,
      windows: (originalLineCount, modifiedLineCount) =>
        reviewPeekDiffWindows(
          originalLineCount,
          modifiedLineCount,
          ranges,
          side,
          mappings,
        ),
    };
  }

  private async positionRowsForRange(
    path: string,
    side: ReviewDiffSide,
    startLine: number,
    endLine: number,
  ): Promise<{
    readonly diffFile: ReviewDiffFileWire;
    readonly start: GitLabTextDiffRow;
    readonly end: GitLabTextDiffRow;
  } | null> {
    const target = await this.resolveDiff(path, side, []);
    if (!target) return null;
    return {
      diffFile: target.diffFile,
      ...reviewDiffPositionRowsForRange(
        target.mappings,
        side,
        startLine,
        endLine,
      ),
    };
  }

  private async rangeForPositionRows(
    path: string,
    side: ReviewDiffSide,
    start: GitLabTextDiffRow,
    end: GitLabTextDiffRow,
  ): Promise<ReviewUnifiedLineRange | undefined> {
    const target = await this.resolveDiff(path, side, []);
    if (!target) return undefined;
    return reviewDiffSideRangeForPositionRows(
      target.mappings,
      side,
      start,
      end,
    );
  }

  async positionRowsForResourceRange(
    resource: URI,
    startLine: number,
    endLine: number,
  ): Promise<ReviewCodePositionRows | null> {
    const unified = this.unifiedResource(resource);
    if (unified) {
      const rows = unified.positionRowsForRange(startLine, endLine);
      return rows ? { diffFile: unified.diffFile, ...rows } : null;
    }
    const identity = this.resourceIdentity(resource);
    if (!identity) return null;
    return this.positionRowsForRange(
      identity.path,
      identity.side,
      startLine,
      endLine,
    );
  }

  async projectPosition(
    position: GitLabDiffPosition,
    resource: URI,
  ): Promise<ReviewUnifiedLineRange | undefined> {
    const rows = gitLabDiffPositionRows(position);
    if (!rows) return undefined;
    const unified = this.unifiedResource(resource);
    if (unified) {
      if (
        position.old_path !==
          (unified.diffFile.previousPath ?? unified.diffFile.path) ||
        position.new_path !== unified.diffFile.path
      ) {
        return undefined;
      }
      return unified.rangeForPositionRows(rows.start, rows.end);
    }
    const identity = this.resourceIdentity(resource);
    if (!identity) return undefined;
    const positionPath =
      identity.side === "base" ? position.old_path : position.new_path;
    if (positionPath !== identity.path) return undefined;
    return this.rangeForPositionRows(
      identity.path,
      identity.side,
      rows.start,
      rows.end,
    );
  }

  async acquireUnifiedDiff(
    path: string,
    side: ReviewDiffSide,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewUnifiedCodeModelReference | undefined> {
    const target = await this.resolveDiff(path, side, ranges);
    if (!target) return undefined;
    const session = this.requireSession();
    const generation = this.generation;
    const query = new URLSearchParams({
      path,
      version: session.session.sessionId,
      side,
      revision: String(generation),
    });
    const resource = URI.from({
      scheme: REVIEW_UNIFIED_SCHEME,
      path: `/${path}`,
      query: query.toString(),
    });
    const key = resource.toString();
    let entry = this.unifiedResources.get(key);
    if (!entry) {
      let pending = this.unifiedResourcesInFlight.get(key);
      if (!pending) {
        pending = this.createUnifiedResource(path, side, resource, target);
        this.unifiedResourcesInFlight.set(key, pending);
        const clearPending = () => {
          if (this.unifiedResourcesInFlight.get(key) === pending) {
            this.unifiedResourcesInFlight.delete(key);
          }
        };
        void pending.then(clearPending, clearPending);
      }
      entry = await pending;
      if (generation !== this.generation) {
        entry.dispose();
        return undefined;
      }
      this.unifiedResources.set(key, entry);
    }
    entry.references += 1;
    const diffWindows = target.windows(
      entry.originalLineCount,
      entry.modifiedLineCount,
    );
    let disposed = false;
    return {
      model: entry.model,
      target,
      rows: entry.rows,
      windows: reviewUnifiedWindows(
        entry.rows,
        diffWindows.original,
        diffWindows.modified,
      ),
      ranges: reviewUnifiedRangesForSelections(entry.rows, ranges, side),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        entry.references -= 1;
        if (entry.references > 0) return;
        if (this.unifiedResources.get(key) === entry) {
          this.unifiedResources.delete(key);
        }
        entry.dispose();
      },
    };
  }

  unifiedResource(resource: URI): ReviewUnifiedResourceInfo | undefined {
    return this.unifiedResources.get(resource.toString())?.info;
  }

  private resourceIdentity(
    resource: URI,
  ): { readonly path: string; readonly side: ReviewDiffSide } | null {
    const session = this.requireSession();
    if (
      resource.scheme === REVIEW_BASE_SCHEME ||
      resource.scheme === REVIEW_HEAD_SCHEME
    ) {
      const query = new URLSearchParams(resource.query);
      if (query.get("version") !== session.session.sessionId) return null;
      const path = resource.path.replace(/^\/+/, "");
      if (!path) return null;
      return {
        path,
        side: resource.scheme === REVIEW_BASE_SCHEME ? "base" : "head",
      };
    }
    if (resource.scheme !== "file") return null;
    const roots: readonly [string | undefined, ReviewDiffSide][] = [
      [session.session.headRootPath, "head"],
      [session.session.baseRootPath, "base"],
    ];
    for (const [rootPath, side] of roots) {
      if (!rootPath) continue;
      const path = extUri.relativePath(URI.file(rootPath), resource);
      if (path && !path.startsWith("../")) return { path, side };
    }
    return null;
  }

  reset(): void {
    this.unavailableSnippetResources.clear();
    for (const entry of this.unifiedResources.values()) entry.dispose();
    this.unifiedResources.clear();
    this.unifiedResourcesInFlight.clear();
    this.generation += 1;
  }

  private async createUnifiedResource(
    path: string,
    side: ReviewDiffSide,
    resource: URI,
    target: ReviewCodeDiffTarget,
  ): Promise<ReviewUnifiedResourceEntry> {
    const [originalReference, modifiedReference] = await Promise.all([
      this.textModelService.createModelReference(target.original),
      this.textModelService.createModelReference(target.modified),
    ]);
    const originalModel = originalReference.object.textEditorModel;
    const modifiedModel = modifiedReference.object.textEditorModel;
    if (!originalModel || !modifiedModel) {
      originalReference.dispose();
      modifiedReference.dispose();
      throw new Error(
        `Unified preview could not resolve text content: ${path}`,
      );
    }

    const baseLines =
      target.diffFile.status === "added" ? [] : originalModel.getLinesContent();
    const headLines =
      target.diffFile.status === "deleted"
        ? []
        : modifiedModel.getLinesContent();
    const unified = buildReviewUnifiedDiff(
      baseLines,
      headLines,
      target.mappings,
      side,
    );
    const sourceModel =
      target.diffFile.status === "deleted" ? originalModel : modifiedModel;
    let model: ITextModel;
    try {
      model = this.modelService.createModel(
        unified.content,
        this.languageService.createById(sourceModel.getLanguageId()),
        resource,
      );
    } catch (error) {
      originalReference.dispose();
      modifiedReference.dispose();
      throw error;
    }
    let resolverReference: IReference<IResolvedTextEditorModel>;
    try {
      // References and Peek Definition resolve this resource independently.
      // Keep one resolver owner until the inline CodePeek releases the model.
      resolverReference = await this.textModelService.createModelReference(
        resource,
      );
    } catch (error) {
      model.dispose();
      originalReference.dispose();
      modifiedReference.dispose();
      throw error;
    }
    let disposed = false;
    return {
      model,
      rows: unified.rows,
      originalLineCount: originalModel.getLineCount(),
      modifiedLineCount: modifiedModel.getLineCount(),
      references: 0,
      info: {
        path,
        diffFile: target.diffFile,
        rows: unified.rows,
        commentingRanges: unified.commentingRanges,
        targetForRange: (startLine, endLine) =>
          reviewUnifiedTargetForRange(path, unified.rows, startLine, endLine),
        rangeForTarget: (targetSide, startLine, endLine) =>
          reviewUnifiedRangeForTarget(
            unified.rows,
            targetSide,
            startLine,
            endLine,
          ),
        positionRowsForRange: (startLine, endLine) =>
          reviewUnifiedPositionRowsForRange(
            unified.rows,
            startLine,
            endLine,
          ),
        rangeForPositionRows: (start, end) =>
          reviewUnifiedRangeForPositionRows(unified.rows, start, end),
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        resolverReference.dispose();
        originalReference.dispose();
        modifiedReference.dispose();
      },
    };
  }

  private currentCodeRevision(): string | undefined {
    const session = this.sessionModelService.activeModel?.session.session;
    if (!session) return undefined;
    return [
      session.sessionId,
      session.resolvedBaseRef,
      session.headRef,
      session.routePath ?? "",
      session.rootPath,
      session.baseRootPath ?? "",
      session.headRootPath ?? "",
    ].join("\n");
  }

  private async diffFilesForSession(
    session: ReviewDesktopSession,
    scope?: ReviewCommitScope,
  ): Promise<ReviewDiffFileWire[] | undefined> {
    const routePath = session.session.routePath ?? "/";
    try {
      const response = await this.request(
        session,
        reviewDiffFilesUrl(session.sessionUrl, routePath),
        {
          method: "POST",
          headers: {
            "x-review-token": session.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ includePatch: false, commit: scope?.commit }),
          signal: AbortSignal.timeout(2_000),
        },
      );
      const result = parseReviewDiffFilesResponse(await response.json());
      if (!response.ok || !result.ok) return undefined;
      return result.files.map((file) => ({
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      }));
    } catch {
      return undefined;
    }
  }

  private async diffPatchForSession(
    session: ReviewDesktopSession,
    path: string,
  ): Promise<string | undefined> {
    const routePath = session.session.routePath ?? "/";
    try {
      const response = await this.request(
        session,
        reviewDiffFilesUrl(session.sessionUrl, routePath),
        {
          method: "POST",
          headers: {
            "x-review-token": session.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ includePatch: true, paths: [path] }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      const result = parseReviewDiffFilesResponse(await response.json());
      if (!response.ok || !result.ok) return undefined;
      return result.files.find((file) => file.path === path)?.patch;
    } catch {
      return undefined;
    }
  }

  private async provideDiffContent(
    side: ReviewDiffSide,
    resource: URI,
  ): Promise<ITextModel> {
    const existing = this.modelService.getModel(resource);
    if (existing) return existing;
    const session = this.requireSession();
    const query = new URLSearchParams(resource.query);
    const canonicalPath = query.get("path");
    if (!canonicalPath) throw new Error("Review diff URI is missing its path.");
    if (query.get("version") !== session.session.sessionId) {
      throw new Error("Review diff content belongs to a stale session.");
    }
    const commit = query.get("commit");
    const url = new URL(
      `${session.sessionUrl}/__progressive-review/file-content`,
    );
    url.searchParams.set("path", canonicalPath);
    url.searchParams.set("side", side);
    if (commit) url.searchParams.set("commit", commit);
    if (session.session.routePath && session.session.routePath !== "/") {
      url.searchParams.set("document", session.session.routePath);
    }
    const response = await this.request(session, url, {
      headers: { "x-review-token": session.token },
    });
    const result = parseReviewFileContentResponse(await response.json());
    if (!response.ok || !result.ok) {
      throw new Error(
        result.ok
          ? `Review file content returned ${response.status}.`
          : result.error,
      );
    }
    if ("binary" in result) {
      throw new Error(`Binary file cannot be displayed: ${canonicalPath}`);
    }
    const content = "content" in result ? result.content : "";
    if ("absent" in result || ("truncated" in result && result.truncated)) {
      this.unavailableSnippetResources.add(resource.toString());
    } else {
      this.unavailableSnippetResources.delete(resource.toString());
    }
    return this.modelService.createModel(
      content,
      this.languageService.createByFilepathOrFirstLine(
        resource,
        content.split(/\r?\n/, 1)[0],
      ),
      resource,
    );
  }

  private requireSession(): ReviewDesktopSession {
    const session = this.sessionModelService.activeModel?.session;
    if (!session) throw new Error("No active Review Desktop session.");
    return session;
  }

  private request(
    session: ReviewDesktopSession,
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const model = this.sessionModelService.activeModel;
    if (model?.session.session.sessionId !== session.session.sessionId) {
      throw new Error("Review code request belongs to a stale session.");
    }
    return model.request(String(url), init);
  }
}
