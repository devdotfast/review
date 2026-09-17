import assert from "node:assert/strict";
import test from "node:test";

import { CancellationToken } from "../../base/common/cancellation.js";
import { Emitter } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
import { Position } from "../../editor/common/core/position.js";
import { Range } from "../../editor/common/core/range.js";
import type {
  DefinitionProvider,
  HoverProvider,
  ReferenceProvider,
} from "../../editor/common/languages.js";
import type { ITextModel } from "../../editor/common/model.js";
import { ReviewApiLanguageFeatures } from "./reviewApiLanguageFeatures.js";

Object.assign(globalThis, {
  window: globalThis,
  location: { href: "http://localhost/" },
});

test("API language features use each document’s pinned workspace and preserve navigation identity", async () => {
  let definition!: DefinitionProvider,
    hover!: HoverProvider,
    references!: ReferenceProvider;
  const folders: { uri: URI; name: string }[] = [];
  const opened: string[] = [];
  let generation = "";
  const released: string[] = [];
  const added = new Emitter<ITextModel>();
  const removed = new Emitter<ITextModel>();
  const range = new Range(1, 1, 1, 6);
  const sourceModel = (uri: URI) => ({
    uri,
    validatePosition: (p: Position) => p,
    getLanguageId: () => "typescript",
  });
  const features = {
    definitionProvider: {
      register: (_: object, provider: DefinitionProvider) => {
        definition = provider;
        return { dispose() {} };
      },
      ordered: () => [
        {
          provideDefinition(model: ITextModel) {
            return [
              {
                uri: model.uri.with({
                  path: model.uri.path.replace("main.ts", "helper.ts"),
                }),
                range,
              },
              {
                uri: model.uri.with({
                  path: model.uri.path.replace(
                    "main.ts",
                    "node_modules/lib/index.d.ts",
                  ),
                }),
                range,
              },
            ];
          },
        },
      ],
    },
    hoverProvider: {
      register: (_: object, provider: HoverProvider) => {
        hover = provider;
        return { dispose() {} };
      },
      ordered: () => [
        {
          provideHover: (model: ITextModel) => ({
            range,
            contents: [{ value: model.uri.path }],
          }),
        },
      ],
    },
    referenceProvider: {
      register: (_: object, provider: ReferenceProvider) => {
        references = provider;
        return { dispose() {} };
      },
      ordered: () => [
        {
          provideReferences: (model: ITextModel) => [{ uri: model.uri, range }],
        },
      ],
    },
  };
  const bridge = new ReviewApiLanguageFeatures(
    {
      createModelReference: async (uri: URI) => {
        opened.push(uri.fsPath);
        return {
          object: { textEditorModel: sourceModel(uri) },
          dispose: () => released.push(uri.fsPath),
        };
      },
    } as never,
    { onModelAdded: added.event, onModelRemoved: removed.event } as never,
    features as never,
    { activateByEvent: async () => {} } as never,
    { getWorkspace: () => ({ folders }) } as never,
    {
      addFolders: async (rows: typeof folders) => {
        folders.push(...rows);
      },
      removeFolders: async (roots: URI[]) => {
        for (const uri of roots) {
          const index = folders.findIndex(
            (f) => f.uri.toString() === uri.toString(),
          );
          if (index >= 0) folders.splice(index, 1);
        }
      },
    } as never,
    async (uri) => {
      const side = new URLSearchParams(uri.query).get("side");
      return {
        directory: `/cache/${side}${generation}`,
        file: `/cache/${side}${generation}${uri.path}`,
      };
    },
    async (uri) => !uri.path.includes("node_modules"),
  );
  const models = ["base", "head"].map(
    (side) =>
      sourceModel(
        URI.from({
          scheme: "review-api-source",
          authority: "review-a",
          path: "/main.ts",
          query: `version=7&side=${side}`,
        }),
      ) as ITextModel,
  );
  for (const model of models) {
    added.fire(model);
    const result = await definition.provideDefinition(
      model,
      new Position(1, 1),
      CancellationToken.None,
    );
    assert.ok(Array.isArray(result));
    assert.equal(result[0].uri.scheme, "review-api-source");
    assert.equal(result[0].uri.authority, model.uri.authority);
    assert.equal(result[0].uri.query, model.uri.query);
    assert.equal(result[0].uri.path, "/helper.ts");
    assert.equal(result[1].uri.scheme, "file");
    const hovered = await hover.provideHover(
      model,
      new Position(1, 1),
      CancellationToken.None,
    );
    assert.equal(
      hovered?.contents[0].value,
      `/cache/${new URLSearchParams(model.uri.query).get("side")}/main.ts`,
    );
    const refs = await references.provideReferences(
      model,
      new Position(1, 1),
      { includeDeclaration: true },
      CancellationToken.None,
    );
    assert.equal(refs?.[0].uri.toString(), model.uri.toString());
  }
  assert.deepEqual(opened, ["/cache/base/main.ts", "/cache/head/main.ts"]);
  assert.equal(folders.length, 2);
  generation = "-rebuilt";
  const rebuilt = await hover.provideHover(
    models[0],
    new Position(1, 1),
    CancellationToken.None,
  );
  assert.equal(rebuilt?.contents[0].value, "/cache/base-rebuilt/main.ts");
  for (const model of models) removed.fire(model);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(folders.length, 0);
  assert.deepEqual(released.sort(), opened.sort());
  bridge.dispose();
  added.dispose();
  removed.dispose();
});
