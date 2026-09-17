/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Queue } from "../../base/common/async.js";
import { Disposable, type IReference } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import type { ITextModel } from "../../editor/common/model.js";
import type { ILanguageFeaturesService } from "../../editor/common/services/languageFeatures.js";
import type { IModelService } from "../../editor/common/services/model.js";
import type {
  IResolvedTextEditorModel,
  ITextModelService,
} from "../../editor/common/services/resolverService.js";
import type { IWorkspaceContextService } from "../../platform/workspace/common/workspace.js";
import type { IExtensionService } from "../../workbench/services/extensions/common/extensions.js";
import type { IWorkspaceEditingService } from "../../workbench/services/workspaces/common/workspaceEditing.js";

const scheme = "review-api-source";
interface Binding {
  root: URI;
  reference: IReference<IResolvedTextEditorModel>;
}

/** Keep immutable virtual text on screen; ask language servers about its prepared
 * file counterpart. Bind by the document URI (review/version/side), never by the
 * currently active review. This also serves unified peeks through their source models.
 */
export class ReviewApiLanguageFeatures extends Disposable {
  private readonly bindings = new Map<string, Promise<Binding>>();
  private readonly roots = new Map<string, URI>();
  private readonly queue = this._register(new Queue<void>());

  constructor(
    private readonly models: ITextModelService,
    modelService: IModelService,
    features: ILanguageFeaturesService,
    private readonly extensions: IExtensionService,
    private readonly workspace: IWorkspaceContextService,
    private readonly editing: IWorkspaceEditingService,
    private readonly source: (
      uri: URI,
    ) => Promise<{ directory: string; file: string }>,
    private readonly pinned: (uri: URI) => Promise<boolean>,
  ) {
    super();
    const selector = { scheme, exclusive: true };
    const withModel = async <T>(
      model: ITextModel,
      run: (model: ITextModel) => Promise<T>,
    ): Promise<T> => {
      // Explicit rebuilding can replace a checkout while this virtual document
      // stays open. Refresh its environment before the next language request.
      const target = await this.source(model.uri);
      const existing = this.bindings.get(model.uri.toString());
      if (
        existing &&
        (await existing).reference.object.textEditorModel.uri.toString() !==
          URI.file(target.file).toString()
      )
        this.release(model.uri);
      const binding = await this.bind(model.uri, target);
      return run(binding.reference.object.textEditorModel);
    };
    this._register(
      features.definitionProvider.register(selector, {
        provideDefinition: (model, position, token) =>
          withModel(model, async (source) => {
            const results = await Promise.all(
              features.definitionProvider
                .ordered(source)
                .map((provider) =>
                  Promise.resolve(
                    provider.provideDefinition(
                      source,
                      source.validatePosition(position),
                      token,
                    ),
                  ).catch(() => undefined),
                ),
            );
            const locations = results.flatMap((result) =>
              result ? (Array.isArray(result) ? result : [result]) : [],
            );
            return Promise.all(
              locations.map(async (location) => ({
                ...location,
                uri: await this.virtualLocation(
                  model.uri,
                  source.uri,
                  location.uri,
                ),
              })),
            );
          }),
      }),
    );
    this._register(
      features.hoverProvider.register(selector, {
        provideHover: (model, position, token) =>
          withModel(model, async (source) => {
            const results = await Promise.all(
              features.hoverProvider
                .ordered(source)
                .map((provider) =>
                  Promise.resolve(
                    provider.provideHover(
                      source,
                      source.validatePosition(position),
                      token,
                    ),
                  ).catch(() => undefined),
                ),
            );
            const hovers = results.filter((result) => result != null);
            return hovers.length
              ? {
                  ...hovers[0],
                  contents: hovers.flatMap((hover) => hover.contents),
                }
              : undefined;
          }),
      }),
    );
    this._register(
      features.referenceProvider.register(selector, {
        provideReferences: (model, position, context, token) =>
          withModel(model, async (source) => {
            const results = await Promise.all(
              features.referenceProvider
                .ordered(source)
                .map((provider) =>
                  Promise.resolve(
                    provider.provideReferences(
                      source,
                      source.validatePosition(position),
                      context,
                      token,
                    ),
                  ).catch(() => undefined),
                ),
            );
            const locations = results.flatMap((result) => result ?? []);
            return Promise.all(
              locations.map(async (location) => ({
                uri: await this.virtualLocation(
                  model.uri,
                  source.uri,
                  location.uri,
                ),
                range: location.range,
              })),
            );
          }),
      }),
    );
    this._register(
      modelService.onModelAdded((model) => {
        if (
          model.uri.scheme === scheme &&
          !new URLSearchParams(model.uri.query).has("empty")
        )
          void this.bind(model.uri).catch(() => {}); // Preparation status and retry live in the canvas.
      }),
    );
    this._register(
      modelService.onModelRemoved((model) => this.release(model.uri)),
    );
  }

  private async virtualLocation(
    virtual: URI,
    source: URI,
    target: URI,
  ): Promise<URI> {
    // Files outside the project (e.g. SDKs) keep their native URI.
    const relative = virtual.path.slice(1);
    const root = source.path.slice(0, -relative.length);
    if (target.scheme !== "file" || !target.path.startsWith(root))
      return target;
    const candidate = virtual.with({
      path: "/" + target.path.slice(root.length),
    });
    return (await this.pinned(candidate)) ? candidate : target;
  }

  private bind(
    uri: URI,
    prepared?: { directory: string; file: string },
  ): Promise<Binding> {
    const key = uri.toString();
    const existing = this.bindings.get(key);
    if (existing) return existing;
    let acquiredRoot: URI | undefined;
    const binding = (async () => {
      const target = prepared ?? (await this.source(uri));
      const root = URI.file(target.directory);
      acquiredRoot = root;
      this.roots.set(key, root);
      await this.queue.queue(async () => {
        if (
          !this.workspace
            .getWorkspace()
            .folders.some((folder) => folder.uri.toString() === root.toString())
        )
          await this.editing.addFolders(
            [
              {
                uri: root,
                name: `Review ${target.directory.split(/[\\/]/).at(-1)!.slice(0, 8)}`,
              },
            ],
            true,
          );
      });
      const reference = await this.models.createModelReference(
        URI.file(target.file),
      );
      try {
        await this.extensions.activateByEvent(
          `onLanguage:${reference.object.textEditorModel.getLanguageId()}`,
        );
        return { root, reference };
      } catch (error) {
        reference.dispose();
        throw error;
      }
    })();
    this.bindings.set(key, binding);
    void binding.catch(() => {
      if (this.bindings.get(key) === binding) this.bindings.delete(key);
      if (!this.bindings.has(key)) this.roots.delete(key);
      if (acquiredRoot)
        void this.removeUnusedRoot(acquiredRoot).catch(() => {});
    });
    return binding;
  }

  private release(uri: URI) {
    const binding = this.bindings.get(uri.toString());
    if (!binding) return;
    this.bindings.delete(uri.toString());
    void binding
      .then((value) => {
        value.reference.dispose();
        if (!this.bindings.has(uri.toString()))
          this.roots.delete(uri.toString());
        return this.removeUnusedRoot(value.root);
      })
      .catch(() => {});
  }

  private removeUnusedRoot(root: URI) {
    return this.queue.queue(async () => {
      if (
        ![...this.roots.values()].some(
          (value) => value.toString() === root.toString(),
        )
      )
        await this.editing.removeFolders([root], true);
    });
  }

  override dispose() {
    for (const key of this.bindings.keys()) this.release(URI.parse(key));
    super.dispose();
  }
}
