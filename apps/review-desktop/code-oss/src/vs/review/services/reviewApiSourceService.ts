/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import type { IFileStat } from "../../platform/files/common/files.js";
import { reviewPeekWindows } from "../common/reviewPeek.js";
import type {
  ReviewDiffSide,
  ReviewInlineEditorRange,
  ReviewDiffFileWire,
  ReviewInlineEditorFactory,
  ReviewDiffViewFactory,
  ReviewSourceEntry,
  ReviewApiSourceLocation,
} from "../common/reviewProtocol.js";
import type {
  ReviewCodeModelReference,
} from "./reviewCodeResourceService.js";
import type { ReviewInlineEditorService, ReviewInlineSource } from "./reviewInlineEditorService.js";
import type { ReviewDiffViewService, ReviewDiffViewSource } from "./reviewDiffViewService.js";
import { IReviewSessionService } from "./reviewSessionService.js";
import { IReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";

export interface ApiSourceTarget extends ReviewApiSourceLocation {
  reviewId: string;
}

export const REVIEW_API_SOURCE_SCHEME = "review-api-source";
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

  constructor(
    @IReviewSessionService private readonly session: IReviewSessionService,
    @ITextModelService private readonly models: ITextModelService,
    @IModelService modelService: IModelService,
    @ILanguageService languages: ILanguageService,
    @IEditorService private readonly editors: IEditorService,
    @IReviewCanvasEditorTabsService private readonly tabs: IReviewCanvasEditorTabsService,
  ) {
    super();
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
