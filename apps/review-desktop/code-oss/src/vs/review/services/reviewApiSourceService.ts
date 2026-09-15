/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { Emitter, type Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { IEditorWorkerService } from "../../editor/common/services/editorWorker.js";
import { diffEditorDefaultOptions } from "../../editor/common/config/diffEditor.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { EditorResourceAccessor, SideBySideEditor } from "../../workbench/common/editor.js";
import type { EditorInput } from "../../workbench/common/editor/editorInput.js";
import type { IFileStat } from "../../platform/files/common/files.js";
import { reviewPeekWindows, reviewPeekDiffWindows } from "../common/reviewPeek.js";
import type {
  ReviewDiffSide,
  ReviewInlineEditorRange,
  ReviewDiffFileWire,
  ReviewInlineEditorFactory,
  ReviewDiffViewFactory,
  ReviewSourceEntry,
  ReviewApiFeedbackContext,
  ReviewApiSourceLocation,
  CodeThreadTarget,
} from "../common/reviewProtocol.js";
import { ApiComments, ReviewApiClient, createGitLabTextDiffPosition, gitLabDiffPositionRows } from "../common/reviewProtocol.js";
import type {
  ReviewCodeModelReference,
  ReviewCodeDiffTarget,
} from "./reviewCodeResourceService.js";
import type { ReviewInlineEditorService, ReviewInlineSource } from "./reviewInlineEditorService.js";
import type { ReviewDiffViewService, ReviewDiffViewSource } from "./reviewDiffViewService.js";
import { IReviewSessionService } from "./reviewSessionService.js";
import { IReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";

export interface ApiSourceTarget extends ReviewApiSourceLocation {
  reviewId: string;
}

interface SourceFeedback {
  key: string;
  abort: AbortController;
  context?: ReviewApiFeedbackContext & { comments: ApiComments };
}

export const REVIEW_API_SOURCE_SCHEME = "review-api-source";
export function apiFeedbackSource(context: ReviewApiFeedbackContext | undefined, resource: URI) {
  if (!context || resource.scheme !== REVIEW_API_SOURCE_SCHEME || resource.authority !== context.reviewId) return;
  const query = new URLSearchParams(resource.query);
  const side = query.get("side");
  if (Number(query.get("version")) !== context.version || query.has("empty") || (side !== "base" && side !== "head")) return;
  return { context, side, path: resource.path.slice(1), commit: query.get("commit") ?? undefined } as const;
}

export function apiSourceUri(target: ApiSourceTarget, empty = false): URI {
  const query = new URLSearchParams({ version: String(target.version), side: target.side });
  if (target.commit) query.set("commit", target.commit);
  if (empty) query.set("empty", "true");
  return URI.from({
    scheme: REVIEW_API_SOURCE_SCHEME,
    authority: target.reviewId,
    path: `/${target.file}`,
    query: query.toString(),
  });
}

export const IReviewApiSourceService =
  createDecorator<IReviewApiSourceService>("reviewApiSourceService");
export interface IReviewApiSourceService {
  readonly _serviceBrand: undefined;
  readonly feedback: ReviewApiFeedbackContext | undefined;
  readonly onDidChangeFeedback: Event<void>;
  bindFeedback(context: ReviewApiFeedbackContext, owner: EditorInput): () => void;
  commentTarget(resource: URI, range: ReviewInlineEditorRange): Promise<CodeThreadTarget | null>;
  commentRange(target: CodeThreadTarget, resource: URI): ReviewInlineEditorRange | undefined;
  open(target: ApiSourceTarget, range?: ReviewInlineEditorRange): Promise<void>;
  children(resource: URI): Promise<IFileStat[]>;
  canvas(
    reviewId: string,
    version: () => number,
    inline: ReviewInlineEditorService,
    diff: ReviewDiffViewService,
  ): {
    inlineEditors: ReviewInlineEditorFactory;
    diffView: ReviewDiffViewFactory;
  };
}

/** Pinned, read-only native models. Only the desktop API reads repository files. */
export class ReviewApiSourceService extends Disposable implements IReviewApiSourceService {
  declare readonly _serviceBrand: undefined;
  private readonly feedbackChanged = this._register(new Emitter<void>());
  readonly onDidChangeFeedback = this.feedbackChanged.event;
  private readonly feedbackBindings = new Map<EditorInput, ReviewApiFeedbackContext>();
  private activeFeedback: ReviewApiFeedbackContext | undefined;
  private sourceFeedback?: SourceFeedback;
  get feedback() { return this.activeFeedback; }

  bindFeedback(context: ReviewApiFeedbackContext, owner: EditorInput) {
    this.feedbackBindings.set(owner, context);
    this.selectFeedback();
    return () => {
      if (this.feedbackBindings.get(owner) !== context) return;
      this.feedbackBindings.delete(owner);
      this.selectFeedback();
    };
  }

  private selectFeedback() {
    const editor = this.editors.activeEditor;
    let next = editor ? this.feedbackBindings.get(editor) : undefined;
    const resource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
    if (!next && resource) {
      next = [...this.feedbackBindings.values()].find(context =>
        apiFeedbackSource(context, resource) ||
        (resource.scheme === "devfast-review-canvas" && resource.authority === "api-source" &&
          resource.path === `/${context.reviewId}/${context.version}`),
      );
    }
    if (!next && resource && (resource.scheme === REVIEW_API_SOURCE_SCHEME ||
      (resource.scheme === "devfast-review-canvas" && resource.authority === "api-source"))) {
      const tree = resource.scheme === "devfast-review-canvas";
      const reviewId = tree ? resource.path.split("/")[1] : resource.authority;
      const version = Number(tree ? resource.path.split("/")[2] : new URLSearchParams(resource.query).get("version") ?? undefined);
      if (reviewId && Number.isInteger(version) && version >= 0) {
        const key = `${reviewId}/${version}`;
        if (this.sourceFeedback?.key !== key) {
          this.clearSourceFeedback();
          const state = this.sourceFeedback = { key, abort: new AbortController() };
          void this.loadSourceFeedback(reviewId, version, state);
        }
        next = this.sourceFeedback?.context;
      } else this.clearSourceFeedback();
    } else this.clearSourceFeedback();
    if (next === this.activeFeedback) return;
    this.activeFeedback = next;
    this.feedbackChanged.fire();
  }

  private clearSourceFeedback() {
    this.sourceFeedback?.abort.abort();
    this.sourceFeedback?.context?.comments.dispose();
    this.sourceFeedback = undefined;
  }

  private async loadSourceFeedback(reviewId: string, version: number, state: SourceFeedback) {
    try {
      const client = new ReviewApiClient(await this.session.getConnection());
      const snapshot = await client.read<{ pins: { base: string; head: string } }>(
        `/${encodeURIComponent(reviewId)}?full=true&version=${version}`, state.abort.signal,
      );
      if (state.abort.signal.aborted) return;
      const comments = new ApiComments(client, reviewId, () => version);
      state.context = { reviewId, version, pins: snapshot.pins, comments };
      comments.start();
      await comments.refresh();
      if (!state.abort.signal.aborted) this.selectFeedback();
    } catch (error) {
      if (state.abort.signal.aborted) return;
      this.clearSourceFeedback();
      this.activeFeedback = undefined;
      this.feedbackChanged.fire();
      this.notifications.error(`Could not load review comments: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async commentTarget(resource: URI, range: ReviewInlineEditorRange): Promise<CodeThreadTarget | null> {
    const source = apiFeedbackSource(this.feedback, resource);
    if (!source) return null;
    const { context, side, path, commit } = source;
    let pins = context.pins;
    if (commit) {
      const commits = await this.read<{ commit: string; parentCommit: string }[]>(context.reviewId, "/commits", { version: context.version });
      const selected = commits.find(item => item.commit === commit);
      if (!selected) return null;
      pins = { base: selected.parentCommit, head: selected.commit };
    }
    const files = await this.read<ReviewDiffFileWire[]>(context.reviewId, "/diff", { version: context.version, commit });
    const file = files.find(file => (side === "head" ? file.path : file.previousPath ?? file.path) === path);
    const row = (line: number) => ({ old_line: side === "base" ? line : null, new_line: side === "head" ? line : null });
    const position = createGitLabTextDiffPosition({
      base_sha: pins.base, start_sha: pins.base, head_sha: pins.head,
      old_path: file?.previousPath ?? file?.path ?? path, new_path: file?.path ?? path,
      start: row(range.startLine), end: row(range.endLine),
    });
    return { kind: "code", original_position: position, position };
  }

  commentRange(target: CodeThreadTarget, resource: URI): ReviewInlineEditorRange | undefined {
    const source = apiFeedbackSource(this.feedback, resource);
    if (!source || target.change_position) return;
    const { context, side, commit } = source;
    if (commit ? target.position.head_sha !== commit : target.position.head_sha !== context.pins.head || target.position.start_sha !== context.pins.base) return;
    const path = side === "base" ? target.position.old_path : target.position.new_path;
    if (path !== source.path) return;
    const rows = gitLabDiffPositionRows(target.position);
    const start = side === "base" ? rows?.start.old_line : rows?.start.new_line;
    const end = side === "base" ? rows?.end.old_line : rows?.end.new_line;
    return start != null && end != null ? { startLine: start, endLine: end } : undefined;
  }

  constructor(
    @IReviewSessionService private readonly session: IReviewSessionService,
    @ITextModelService private readonly models: ITextModelService,
    @IModelService modelService: IModelService,
    @ILanguageService languages: ILanguageService,
    @IEditorWorkerService private readonly worker: IEditorWorkerService,
    @IEditorService private readonly editors: IEditorService,
    @IReviewCanvasEditorTabsService private readonly tabs: IReviewCanvasEditorTabsService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this._register(toDisposable(() => this.clearSourceFeedback()));
    this._register(editors.onDidActiveEditorChange(() => this.selectFeedback()));
    this._register(
      models.registerTextModelContentProvider(REVIEW_API_SOURCE_SCHEME, {
        provideTextContent: async (resource) => {
          const query = new URLSearchParams(resource.query);
          const target = {
            reviewId: resource.authority,
            version: Number(query.get("version")),
            side: query.get("side") ?? "",
            file: resource.path.slice(1),
            commit: query.get("commit") ?? undefined,
          };
          const body = query.has("empty")
            ? { text: "" }
            : await this.read<{ text: string }>(target.reviewId, "/file", target);
          return (
            modelService.getModel(resource) ??
            modelService.createModel(
              body.text,
              languages.createByFilepathOrFirstLine(resource, body.text.split("\n", 1)[0]),
              resource,
            )
          );
        },
      }),
    );
  }

  private async read<T>(
    reviewId: string,
    route: string,
    query: Record<string, string | number | undefined>,
  ): Promise<T> {
    const { serverUrl, token } = await this.session.getConnection();
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([key, value]) => key !== "reviewId" && value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const response = await fetch(
      `${serverUrl}/reviews-api/${encodeURIComponent(reviewId)}${route}?${params}`,
      { headers: { "x-review-token": token } },
    );
    if (!response.ok)
      throw new Error((await response.json()).error ?? "Could not read pinned source.");
    return response.json();
  }

  async open(target: ApiSourceTarget, range?: ReviewInlineEditorRange): Promise<void> {
    const pane = await this.editors.openEditor({
      resource: apiSourceUri(target),
      options: {
        pinned: true,
        ...(range
          ? {
              selection: {
                startLineNumber: range.startLine,
                startColumn: 1,
                endLineNumber: range.endLine,
                endColumn: Number.MAX_SAFE_INTEGER,
              },
            }
          : {}),
      },
    });
    if (pane?.input) this.tabs.registerReviewEditor(target.reviewId, pane.input);
  }

  async children(resource: URI): Promise<IFileStat[]> {
    const query = new URLSearchParams(resource.query);
    const entries = await this.read<ReviewSourceEntry[]>(resource.authority, "/tree", {
      version: Number(query.get("version")),
      side: query.get("side") ?? "head",
      path: resource.path.slice(1),
      commit: query.get("commit") ?? undefined,
    });
    return entries.map((entry) => ({
      resource: resource.with({ path: `/${entry.path}` }),
      name: entry.path.split("/").at(-1)!,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "directory",
      isSymbolicLink: false,
      readonly: true,
      children: undefined,
    }));
  }

  private async snippet(
    target: ApiSourceTarget,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewCodeModelReference> {
    const resource = apiSourceUri(target);
    const reference = await this.models.createModelReference(resource);
    try {
      const model = reference.object.textEditorModel;
      return {
        model,
        target: { resource, workingTreeFallback: false },
        windows: reviewPeekWindows(model.getLineCount(), ranges, "content"),
        dispose: () => reference.dispose(),
      };
    } catch (error) {
      reference.dispose();
      throw error;
    }
  }

  private async peekDiff(
    target: ApiSourceTarget,
    ranges: readonly ReviewInlineEditorRange[],
  ): Promise<ReviewCodeDiffTarget | undefined> {
    const files = await this.read<ReviewDiffFileWire[]>(target.reviewId, "/diff", {
      version: target.version,
      commit: target.commit,
    });
    const file = files.find(
      (file) =>
        (target.side === "base" ? (file.previousPath ?? file.path) : file.path) === target.file,
    );
    if (!file) return undefined;
    const original = apiSourceUri(
      { ...target, side: "base", file: file.previousPath ?? file.path },
      file.status === "added",
    );
    const modified = apiSourceUri(
      { ...target, side: "head", file: file.path },
      file.status === "deleted",
    );
    const left = await this.models.createModelReference(original);
    try {
      const right = await this.models.createModelReference(modified);
      try {
        const diff = await this.worker.computeDiff(
          original,
          modified,
          {
            ignoreTrimWhitespace: false,
            computeMoves: false,
            maxComputationTimeMs: diffEditorDefaultOptions.maxComputationTime,
          },
          "advanced",
        );
        if (!diff || diff.quitEarly) return undefined; // The pinned snippet still works.
        const mappings = diff.changes.map((change) => ({
          originalStartLine: change.original.startLineNumber,
          originalEndLineExclusive: change.original.endLineNumberExclusive,
          modifiedStartLine: change.modified.startLineNumber,
          modifiedEndLineExclusive: change.modified.endLineNumberExclusive,
        }));
        return {
          original,
          modified,
          diffFile: file,
          mappings,
          windows: (leftCount, rightCount) =>
            reviewPeekDiffWindows(leftCount, rightCount, ranges, target.side, mappings),
        };
      } finally {
        right.dispose();
      }
    } finally {
      left.dispose();
    }
  }

  canvas(
    reviewId: string,
    version: () => number,
    inline: ReviewInlineEditorService,
    diff: ReviewDiffViewService,
  ) {
    const source = (
      file: string,
      side: ReviewDiffSide,
      ranges: readonly ReviewInlineEditorRange[],
    ): ReviewInlineSource => {
      const target = { reviewId, version: version(), file, side };
      return {
        snippet: () => this.snippet(target, ranges),
        diff: () => this.peekDiff(target, ranges),
      };
    };
    const diffSource: ReviewDiffViewSource = {
      files: (scope) => this.read(reviewId, "/diff", { version: version(), commit: scope?.commit }),
      load: async (scope) => {
        // Capture before awaiting: a live edit must not mix two versions' pins.
        const current = version();
        const commit = scope?.commit;
        const files = await this.read<ReviewDiffFileWire[]>(reviewId, "/diff", {
          version: current,
          commit,
        });
        return {
          sourceUri: URI.from({
            scheme: "review-api-diff",
            authority: reviewId,
            path: `/${current}`,
            query: commit ? `commit=${encodeURIComponent(commit)}` : undefined,
          }),
          entries: files.map((file) => {
            const original =
              file.status === "added"
                ? undefined
                : apiSourceUri({
                    reviewId,
                    version: current,
                    side: "base",
                    file: file.previousPath ?? file.path,
                    commit,
                  });
            const modified =
              file.status === "deleted"
                ? undefined
                : apiSourceUri({
                    reviewId,
                    version: current,
                    side: "head",
                    file: file.path,
                    commit,
                  });
            return { file, original, modified, goToFileResource: (modified ?? original)! };
          }),
        };
      },
    };
    return {
      inlineEditors: {
        create: (spec) => inline.create(spec, source(spec.path, spec.side, spec.ranges)),
        find: (spec, query) => inline.find(spec, query, source(spec.path, spec.side, spec.ranges)),
      } satisfies ReviewInlineEditorFactory,
      diffView: {
        create: (spec) => diff.create(spec, diffSource),
        files: diffSource.files,
      } satisfies ReviewDiffViewFactory,
    };
  }
}
