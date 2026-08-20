/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from "../../base/common/cancellation.js";
import { Position } from "../../editor/common/core/position.js";
import { Range } from "../../editor/common/core/range.js";
import type { LanguageFeatureRegistry } from "../../editor/common/languageFeatureRegistry.js";
import type {
  DefinitionProvider,
  Hover,
  HoverProvider,
  LocationLink,
} from "../../editor/common/languages.js";
import type { ITextModel } from "../../editor/common/model.js";
import type { ITextModelService } from "../../editor/common/services/resolverService.js";
import type { IExtensionService } from "../../workbench/services/extensions/common/extensions.js";
import type { IReviewCodeResourceService } from "./reviewCodeResourceService.js";

type UnifiedLanguageFeatureResources = Pick<
  IReviewCodeResourceService,
  "target" | "unifiedResource"
>;
type UnifiedLanguageFeatureModelService = Pick<
  ITextModelService,
  "createModelReference"
>;
type UnifiedLanguageFeatureExtensionService = Pick<
  IExtensionService,
  "activateByEvent"
>;
type DefinitionResolver = (
  providers: LanguageFeatureRegistry<DefinitionProvider>,
  model: ITextModel,
  position: Position,
  recursive: boolean,
  token: CancellationToken,
) => Promise<LocationLink[]>;
type HoverResolver = (
  providers: LanguageFeatureRegistry<HoverProvider>,
  model: ITextModel,
  position: Position,
  token: CancellationToken,
  recursive: boolean,
) => Promise<Hover[]>;

interface UnifiedSourcePosition {
  readonly sourceModel: ITextModel;
  readonly sourcePosition: Position;
  readonly unifiedLine: number;
}

export async function provideReviewUnifiedDefinition(
  resources: UnifiedLanguageFeatureResources,
  textModelService: UnifiedLanguageFeatureModelService,
  extensionService: UnifiedLanguageFeatureExtensionService,
  definitionProviders: LanguageFeatureRegistry<DefinitionProvider>,
  model: ITextModel,
  position: Position,
  token: CancellationToken,
  resolveDefinitions: DefinitionResolver,
): Promise<LocationLink[]> {
  return withReviewUnifiedSourcePosition(
    resources,
    textModelService,
    extensionService,
    model,
    position,
    [],
    async ({ sourceModel, sourcePosition, unifiedLine }) => {
      const definitions = await resolveDefinitions(
        definitionProviders,
        sourceModel,
        sourcePosition,
        false,
        token,
      );
      const resolvedDefinitions = (
        await Promise.all(
          definitions.map(async (definition) => {
            const targets = await followSameFileDefinition(
              definitionProviders,
              sourceModel,
              definition,
              token,
              resolveDefinitions,
            );
            return targets.map((targetDefinition) => ({
              ...targetDefinition,
              originSelectionRange: definition.originSelectionRange,
            }));
          }),
        )
      ).flat();
      return resolvedDefinitions.map((definition) => ({
        ...definition,
        originSelectionRange: definition.originSelectionRange
          ? model.validateRange(
              new Range(
                unifiedLine,
                definition.originSelectionRange.startColumn,
                unifiedLine,
                definition.originSelectionRange.endColumn,
              ),
            )
          : undefined,
      }));
    },
  );
}

export async function provideReviewUnifiedHover(
  resources: UnifiedLanguageFeatureResources,
  textModelService: UnifiedLanguageFeatureModelService,
  extensionService: UnifiedLanguageFeatureExtensionService,
  hoverProviders: LanguageFeatureRegistry<HoverProvider>,
  model: ITextModel,
  position: Position,
  token: CancellationToken,
  resolveHovers: HoverResolver,
): Promise<Hover | undefined> {
  return withReviewUnifiedSourcePosition(
    resources,
    textModelService,
    extensionService,
    model,
    position,
    undefined,
    async ({ sourceModel, sourcePosition, unifiedLine }) => {
      const hovers = await resolveHovers(
        hoverProviders,
        sourceModel,
        sourcePosition,
        token,
        false,
      );
      const first = hovers[0];
      if (!first) return undefined;
      return {
        ...first,
        contents: hovers.flatMap((hover) => hover.contents),
        range: first.range
          ? model.validateRange(
              new Range(
                unifiedLine,
                first.range.startColumn,
                unifiedLine,
                first.range.endColumn,
              ),
            )
          : undefined,
      };
    },
  );
}

async function withReviewUnifiedSourcePosition<T>(
  resources: UnifiedLanguageFeatureResources,
  textModelService: UnifiedLanguageFeatureModelService,
  extensionService: UnifiedLanguageFeatureExtensionService,
  model: ITextModel,
  position: Position,
  fallback: T,
  provide: (position: UnifiedSourcePosition) => Promise<T>,
): Promise<T> {
  const unified = resources.unifiedResource(model.uri);
  const mapped = unified?.targetForRange(
    position.lineNumber,
    position.lineNumber,
  );
  if (!mapped) return fallback;

  const target = await resources.target(mapped.path, mapped.side);
  const sourceReference = await textModelService.createModelReference(
    target.resource,
  );
  try {
    const sourceModel = sourceReference.object.textEditorModel;
    if (!sourceModel) return fallback;
    const sourcePosition = sourceModel.validatePosition(
      new Position(mapped.startLine, position.column),
    );
    await extensionService.activateByEvent(
      `onLanguage:${sourceModel.getLanguageId()}`,
    );
    return provide({
      sourceModel,
      sourcePosition,
      unifiedLine: position.lineNumber,
    });
  } finally {
    sourceReference.dispose();
  }
}

async function followSameFileDefinition(
  definitionProviders: LanguageFeatureRegistry<DefinitionProvider>,
  sourceModel: ITextModel,
  definition: LocationLink,
  token: CancellationToken,
  resolveDefinitions: DefinitionResolver,
): Promise<LocationLink[]> {
  if (definition.uri.toString() !== sourceModel.uri.toString()) {
    return [definition];
  }
  const targetRange = Range.lift(
    definition.targetSelectionRange ?? definition.range,
  );
  const definitions = await resolveDefinitions(
    definitionProviders,
    sourceModel,
    targetRange.getStartPosition(),
    false,
    token,
  );
  const forwarded = definitions.filter(
    (candidate) =>
      candidate.uri.toString() !== definition.uri.toString() ||
      !Range.equalsRange(
        candidate.targetSelectionRange ?? candidate.range,
        targetRange,
      ),
  );
  return forwarded.length > 0 ? forwarded : [definition];
}
