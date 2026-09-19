import { Emitter } from "../../base/common/event.js";
import { evidenceCoordinates } from "../common/reviewSearchEvidence.js";
import { lensFiles } from "../common/reviewLensFiles.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import type { ITextModel } from "../../editor/common/model.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import {
  IFileService,
  type IFileStat,
} from "../../platform/files/common/files.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import {
  reviewPeekWindows,
  reviewPeekDiffWindows,
  reviewPeekLineMappings,
} from "../common/reviewPeek.js";
import type {
  ReviewInlineEditorRange,
  ReviewDiffFileWire,
  ReviewInlineEditorFactory,
  ReviewDiffViewFactory,
  ReviewSourceEntry,
  ReviewApiSourceLocation,
} from "../common/reviewProtocol.js";
import {
  resolveReviewSourceView,
  reviewSourceComparison,
  reviewSourceQuery,
  type ReviewSourceView,
} from "../common/reviewProtocol.js";
import { REVIEW_LANGUAGE_SOURCE_SCHEME } from "../common/reviewReadonlySource.js";
import {
  apiSourceUri,
  sourceLocation,
  sourceTreeUri,
  sourceTreeSelection,
  REVIEW_API_TREE_SCHEME,
  REVIEW_API_SOURCE_SCHEME,
} from "../common/reviewSourceView.js";
import { IReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";
import type {
  ReviewCodeModelReference,
  ReviewCodeDiffTarget,
} from "./reviewCodeResourceService.js";
import {
  IReviewDesktopConnectionService,
  reviewResponseError,
} from "./reviewDesktopConnectionService.js";
import type {
  ReviewDiffViewService,
  ReviewDiffViewSource,
} from "./reviewDiffViewService.js";
import type {
  ReviewInlineEditorService,
  ReviewInlineSource,
} from "./reviewInlineEditorService.js";

export {
  apiSourceUri,
  REVIEW_API_SOURCE_SCHEME,
} from "../common/reviewSourceView.js";

export type ApiSourceTarget = ReviewApiSourceLocation;

/** Recover the immutable source identity even when no legacy session is active. */
export function apiSourceTarget(resource: URI): ApiSourceTarget | undefined {
  if (resource.scheme !== REVIEW_API_SOURCE_SCHEME) return undefined;
  const query = new URLSearchParams(resource.query);
  const version = Number(query.get("version"));
  const side = query.get("side");
  if (
    !resource.authority ||
    !query.has("version") ||
    !Number.isInteger(version) ||
    version < 0 ||
    (side !== "base" && side !== "head")
  )
    return undefined;
  return {
    view: { reviewId: resource.authority, version, commit: query.get("commit") ?? undefined, generation: query.get("generation") ?? undefined },
    side,
    file: resource.path.slice(1),
  };
}

export const IReviewApiSourceService = createDecorator<IReviewApiSourceService>(
  "reviewApiSourceService",
);
export interface IReviewApiSourceService {
  readonly _serviceBrand: undefined;
  open(target: ApiSourceTarget, range?: ReviewInlineEditorRange): Promise<void>;
  children(resource: URI): Promise<IFileStat[]>;
  openDiff(view: ReviewSourceView, path: string): Promise<void>;
  canvas(
    view: () => ReviewSourceView,
    inline: ReviewInlineEditorService,
    diff: ReviewDiffViewService,
  ): {
    inlineEditors: ReviewInlineEditorFactory;
    diffView: ReviewDiffViewFactory;
  };
}

/** Resolve native or retained resources once; all review surfaces share this path. */
export class ReviewApiSourceService
  extends Disposable
  implements IReviewApiSourceService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IReviewDesktopConnectionService
    private readonly session: IReviewDesktopConnectionService,
    @ITextModelService private readonly models: ITextModelService,
    @IModelService modelService: IModelService,
    @ILanguageService languages: ILanguageService,
    @IEditorService private readonly editors: IEditorService,
    @IReviewCanvasEditorTabsService
    private readonly tabs: IReviewCanvasEditorTabsService,
    @IFileService private readonly files: IFileService,
  ) {
    super();
    this._register(
      models.registerTextModelContentProvider(REVIEW_API_SOURCE_SCHEME, {
        provideTextContent: async (resource) => {
          const existing = modelService.getModel(resource);
          if (existing) return existing;
          const query = new URLSearchParams(resource.query);
          const target = sourceLocation(resource);
          const body = query.has("empty")
            ? { text: "" }
            : await this.read<{ text: string; localPath?: string }>(
                target.view.reviewId,
                "/file",
                {
                  ...reviewSourceQuery(target.view),
                  side: target.side,
                  file: target.file,
                },
              );
          const model =
            modelService.getModel(resource) ??
            modelService.createModel(
              body.text,
              languages.createByFilepathOrFirstLine(
                resource,
                body.text.split("\n", 1)[0],
              ),
              resource,
            );
          if (body.localPath) {
            this.followDisk(
              model,
              URI.file(body.localPath),
              async () =>
                (
                  await this.read<{ text: string }>(
                    target.view.reviewId,
                    "/file",
                    {
                      ...reviewSourceQuery(target.view),
                      side: target.side,
                      file: target.file,
                    },
                  )
                ).text,
            );
          }
          return model;
        },
      }),
    );
    this._register(
      models.registerTextModelContentProvider(REVIEW_LANGUAGE_SOURCE_SCHEME, {
        provideTextContent: async (resource) => {
          const existing = modelService.getModel(resource);
          if (existing) return existing;
          const local = URI.file(resource.path);
          const read = async () =>
            (await this.files.readFile(local)).value.toString();
          const model = modelService.createModel(
            await read(),
            languages.createByFilepathOrFirstLine(resource),
            resource,
          );
          this.followDisk(model, local, read);
          return model;
        },
      }),
    );
  }

  private followDisk(
    model: ITextModel,
    local: URI,
    read: () => Promise<string>,
  ): void {
    const owned = this._register(new DisposableStore());
    let revision = 0;
    owned.add(this.files.watch(local));
    owned.add(
      this.files.onDidFilesChange((event) => {
        if (!event.affects(local)) return;
        const request = ++revision;
        void read()
          .then((text) => {
            if (
              !model.isDisposed() &&
              request === revision &&
              model.getValue() !== text
            )
              model.setValue(text);
          })
          .catch(() => {
            /* A missing file cannot supply fresh source. */
          });
      }),
    );
    owned.add(
      model.onWillDispose(() => {
        this._store.delete(owned);
        owned.dispose();
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
      {
        headers: { "x-review-token": token },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw await reviewResponseError(
        response,
        `Could not read pinned source (${response.status}).`,
      );
    return response.json();
  }

  private async sourceResource(
    target: ApiSourceTarget,
    empty = false,
  ): Promise<URI> {
    return apiSourceUri(target, empty);
  }

  async open(
    target: ApiSourceTarget,
    range?: ReviewInlineEditorRange,
  ): Promise<void> {
    const pane = await this.editors.openEditor({
      resource: await this.sourceResource(target),
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
    if (pane?.input)
      this.tabs.registerReviewEditor(target.view.reviewId, pane.input);
  }

  async openDiff(view: ReviewSourceView, path: string): Promise<void> {
    const files = await this.read<ReviewDiffFileWire[]>(
      view.reviewId,
      "/diff",
      reviewSourceQuery(view),
    );
    const file = files.find((file) => file.path === path);
    if (!file)
      throw new Error(`File is not changed in this review version: ${path}`);
    const target = { view, file: path };
    const pane = await this.editors.openEditor({
      original: {
        resource: await this.sourceResource(
          { ...target, file: file.previousPath ?? path, side: "base" },
          file.status === "added",
        ),
      },
      modified: {
        resource: await this.sourceResource(
          { ...target, side: "head" },
          file.status === "deleted",
        ),
      },
      options: { pinned: true },
    });
    if (pane?.input) this.tabs.registerReviewEditor(view.reviewId, pane.input);
  }

  async children(resource: URI): Promise<IFileStat[]> {
    const selection =
      resource.scheme === REVIEW_API_TREE_SCHEME
        ? sourceTreeSelection(resource)
        : undefined;
    let target: ApiSourceTarget;
    if (selection) {
      const snapshot = await this.read<
        Parameters<typeof resolveReviewSourceView>[0]
      >(selection.reviewId, "", {
        full: "true",
        version: selection.kind === "version" ? selection.version : undefined,
      });
      target = {
        view: resolveReviewSourceView(snapshot),
        side: "head",
        file: resource.path.slice(1),
      };
    } else {
      target = sourceLocation(resource);
    }

    const entries = await this.read<ReviewSourceEntry[]>(
      target.view.reviewId,
      "/tree",
      {
        ...reviewSourceQuery(target.view),
        side: target.side,
        path: target.file,
      },
    );
    return entries.map((entry) => ({
      resource:
        selection && entry.kind === "directory"
          ? sourceTreeUri(selection, entry.path)
          : apiSourceUri({ ...target, file: entry.path }),
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
    const resource = await this.sourceResource(target);
    const reference = await this.models.createModelReference(resource);
    try {
      const model = reference.object.textEditorModel;
      return {
        model,
        target: { resource },
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
    files: Promise<readonly ReviewDiffFileWire[]>,
  ): Promise<ReviewCodeDiffTarget | undefined> {
    const file = (await files).find(
      (file) =>
        (target.side === "base"
          ? (file.previousPath ?? file.path)
          : file.path) === target.file,
    );
    if (!file) return undefined;
    // Mappings come from the patch, as in the session path; the editors own the models.
    const patch =
      file.patch ??
      (await this.read<string>(target.view.reviewId, "/diff", {
        ...reviewSourceQuery(target.view),
        file: file.path,
      }));
    const mappings = reviewPeekLineMappings(patch);
    return {
      original: await this.sourceResource(
        { ...target, side: "base", file: file.previousPath ?? file.path },
        file.status === "added",
      ),
      modified: await this.sourceResource(
        { ...target, side: "head", file: file.path },
        file.status === "deleted",
      ),
      diffFile: file,
      mappings,
      windows: (leftCount, rightCount) =>
        reviewPeekDiffWindows(
          leftCount,
          rightCount,
          ranges,
          target.side,
          mappings,
        ),
    };
  }

  canvas(
    view: () => ReviewSourceView,
    inline: ReviewInlineEditorService,
    diff: ReviewDiffViewService,
  ) {
    const lists = new Map<string, Promise<readonly ReviewDiffFileWire[]>>();
    const files = (current: ReviewSourceView) => {
      const key = JSON.stringify(reviewSourceQuery(current));
      let list = lists.get(key);
      if (!list) {
        list = this.read<ReviewDiffFileWire[]>(
          current.reviewId,
          "/diff",
          reviewSourceQuery(current),
        );
        list.catch(() => lists.delete(key));
        lists.set(key, list);
      }
      return list;
    };
    const source = (content: import("../common/reviewProtocol.js").ReviewInlineEditorSpec["content"]): ReviewInlineSource => {
      const {path: file, side, ranges} = evidenceCoordinates(content);
      const target = { view: view(), file, side };
      return {
        snippet: () => this.snippet(target, ranges),
        diff: async () => {
          if (content.kind === "source") return content.ranges.some(range => range.side && range.side !== content.side) ? this.peekDiff(target, ranges, files(target.view)) : undefined;
          const result = content.result;
          const path = (result.file.rhs ?? result.file.lhs!).path;
          return {
            original: apiSourceUri({...target, side: "base", file: result.file.lhs?.path ?? path}),
            modified: apiSourceUri({...target, side: "head", file: result.file.rhs?.path ?? path}),
            diffFile: {path, previousPath: result.file.lhs?.path, status: result.sources.lhs ? result.sources.rhs ? "modified" : "deleted" : "added", additions: 0, deletions: 0},
            mappings: [], windows: () => ({original: [], modified: []}),
          };
        },
      };
    };
    const diffSource: ReviewDiffViewSource = {
      files: (scope) => files(reviewSourceComparison(view(), scope?.commit)),
      load: async (scope, lens) => {
        if (lens && (scope || lens.reviewId !== view().reviewId)) throw new Error("A lens must use its review comparison.");
        // Capture the comparison once; live checkout bytes may change during the load.
        const current = reviewSourceComparison(view(), scope?.commit);
        const entries = lensFiles(await files(current), lens);

        return {
          structuralDiff: async (signal: AbortSignal) => {
            const { serverUrl, token } = await this.session.getConnection();
            const query = new URLSearchParams(Object.entries(reviewSourceQuery(current)).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
            return fetch(
              `${serverUrl}/reviews-api/${encodeURIComponent(current.reviewId)}/structural-diff?${query}`,
              { headers: { "x-review-token": token }, signal },
            );
          },
          sourceUri: URI.from({
            scheme: "review-api-diff",
            authority: current.reviewId,
            path: `/${current.version}/${current.generation ?? ""}`,
            query: current.commit
              ? `commit=${encodeURIComponent(current.commit)}`
              : undefined,
          }),
          entries: await Promise.all(
            entries.map(async (file) => {
              const original =
                file.status === "added"
                  ? undefined
                  : await this.sourceResource({
                      view: current,
                      side: "base",
                      file: file.previousPath ?? file.path,
                    });
              const modified =
                file.status === "deleted"
                  ? undefined
                  : await this.sourceResource({
                      view: current,
                      side: "head",
                      file: file.path,
                    });
              return {
                file,
                original,
                modified,
                goToFileResource: (modified ?? original)!,
              };
            }),
          ),
        };
      },
    };
    const explicitLens = (spec: import("../common/reviewProtocol.js").ReviewDiffViewSpec): import("../common/reviewProtocol.js").ReviewDiffViewHandle => {
      const lifetime = new DisposableStore();
      const errors = lifetime.add(new Emitter<string>());
      const updates: ((progress: import("../common/reviewProtocol.js").ReviewDiffProgress) => void)[] = [];
      const entries: {element: HTMLElement; content: import("../common/reviewProtocol.js").ReviewInlineEditorSpec["content"]}[] = [];
      spec.container.style.overflow = "auto";
      for (const target of spec.lens!.targets) {
        const contents: import("../common/reviewProtocol.js").ReviewInlineEditorSpec["content"][] = target.kind === "results"
          ? target.results.map(result => ({kind: "diffr", result}))
          : target.ranges.map(range => ({kind: "source", path: range.file, side: range.side, ranges: [{startLine: range.fromLine, endLine: range.toLine}]}));
        for (const content of contents) {
          const coordinates = evidenceCoordinates(content);
          const element = spec.container.ownerDocument.createElement("section");
          element.tabIndex = -1;
          element.style.position = "relative";
          element.style.minHeight = "80px";
          spec.container.append(element);
          entries.push({element, content});
          const toolbar = element.ownerDocument.createElement("div");
          toolbar.className = "review-evidence-toolbar";
          const viewed = element.ownerDocument.createElement("button");
          viewed.type = "button";
          viewed.textContent = "Mark viewed";
          viewed.onclick = () => spec.onToggleViewed?.(coordinates.path);
          toolbar.append(viewed);
          element.append(toolbar);
          const editorElement = element.ownerDocument.createElement("div");
          editorElement.style.position = "relative";
          element.append(editorElement);
          if (spec.fileTreeContainer) {
            const link = element.ownerDocument.createElement("button");
            link.className = "review-evidence-file";
            link.textContent = coordinates.path + (content.kind === "source" ? ` (${content.side})` : "");
            link.onclick = () => element.scrollIntoView({block: "start"});
            spec.fileTreeContainer.append(link);
            lifetime.add({dispose: () => link.remove()});
          }
          const handle = lifetime.add(inline.create({container: editorElement, content, title: coordinates.path, heightMode: "content", active: false,
            onDidOpen: () => {void this.open({view: view(), file: coordinates.path, side: coordinates.side}, coordinates.ranges[0]);},
          }, source(content)));
          editorElement.style.height = `${handle.height}px`;
          lifetime.add(handle.onDidChangeHeight(height => editorElement.style.height = `${height}px`));
          const update = (progress: import("../common/reviewProtocol.js").ReviewDiffProgress) => {
            const file = progress.files.find(file => file.path === coordinates.path);
            viewed.hidden = !file || file.total.additions + file.total.deletions === 0;
            viewed.textContent = file?.state === "viewed" ? "Mark unviewed" : `Mark viewed · +${file?.remaining.additions ?? 0} −${file?.remaining.deletions ?? 0}`;
          };
          updates.push(update);
          if (spec.progress) update(spec.progress);
          lifetime.add(handle.onDidError(message => errors.fire(message)));
        }
      }
      return {
        focus: () => entries[0]?.element.focus(),
        setProgress: progress => { for (const update of updates) update(progress); },
        revealSource: range => {
          const entry = entries.find(entry => entry.content.kind === "source" ? entry.content.path === range.file && entry.content.side === range.side : entry.content.result.file[range.side === "base" ? "lhs" : "rhs"]?.path === range.file);
          entry?.element.scrollIntoView({block: "start"});
        },
        onDidError: errors.event,
        dispose: () => {lifetime.dispose(); for (const entry of entries) entry.element.remove();},
      };
    };
    return {
      inlineEditors: {
        create: (spec) =>
          inline.create(spec, source(spec.content)),
        find: (spec, query) =>
          inline.find(spec, query, source(spec.content)),
      } satisfies ReviewInlineEditorFactory,
      diffView: {
        create: (spec) => spec.lens && !spec.lens.wholeFiles ? explicitLens(spec) : diff.create(spec, diffSource),
        files: diffSource.files,
      } satisfies ReviewDiffViewFactory,
    };
  }
}
