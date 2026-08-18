/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from "../../base/common/path.js";
import type { ITextEditorSelection } from "../../platform/editor/common/editor.js";
import {
  createDecorator,
} from "../../platform/instantiation/common/instantiation.js";
import type { IEditorPane } from "../../workbench/common/editor.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import {
  IWorkbenchLayoutService,
  Parts,
} from "../../workbench/services/layout/browser/layoutService.js";
import { IReviewCanvasEditorTabsService } from "./reviewCanvasEditorTabsService.js";
import { IReviewCodeResourceService } from "./reviewCodeResourceService.js";
import { IReviewSessionModelService } from "./reviewSessionModelService.js";

export const IReviewDiffTabsService =
  createDecorator<IReviewDiffTabsService>("reviewDiffTabsService");

export interface IReviewDiffTabsService {
  readonly _serviceBrand: undefined;
  open(args: {
    filePath: string;
    previousPath?: string;
    selection?: ITextEditorSelection;
    preserveFocus?: boolean;
  }): Promise<IEditorPane | undefined>;
}

/** Opens pinned diff tabs and ties their lifetime to the active Review. */
export class ReviewDiffTabsService implements IReviewDiffTabsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IReviewCodeResourceService
    private readonly codeResources: IReviewCodeResourceService,
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
    @IReviewCanvasEditorTabsService
    private readonly tabsService: IReviewCanvasEditorTabsService,
    @IEditorService private readonly editorService: IEditorService,
    @IEditorGroupsService
    private readonly editorGroupsService: IEditorGroupsService,
    @IWorkbenchLayoutService
    private readonly layoutService: IWorkbenchLayoutService,
  ) {}

  async open(args: {
    filePath: string;
    previousPath?: string;
    selection?: ITextEditorSelection;
    preserveFocus?: boolean;
  }): Promise<IEditorPane | undefined> {
    const model = this.sessionModelService.activeModel;
    if (!model) {
      throw new Error("Review session is unavailable.");
    }
    this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
    const modifiedTarget = await this.codeResources.target(
      args.filePath,
      "head",
    );
    const originalTarget = await this.codeResources.target(
      args.previousPath ?? args.filePath,
      "base",
    );
    const options = {
      pinned: true,
      preserveFocus: args.preserveFocus,
      revealIfVisible: true,
      selection: args.selection,
    };
    const pane = await this.editorService.openEditor(
      {
        original: { resource: originalTarget.resource },
        modified: { resource: modifiedTarget.resource },
        label: basename(args.filePath),
        description: `${args.filePath} (base ↔ head)`,
        options,
      },
      this.editorGroupsService.mainPart.activeGroup,
    );
    if (pane?.input) {
      this.tabsService.registerReviewEditor(model.reviewUuid, pane.input);
    }
    return pane;
  }
}
