/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from "../../../../base/common/keyCodes.js";
import { localize2 } from "../../../../nls.js";
import {
  Action2,
  registerAction2,
} from "../../../../platform/actions/common/actions.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { KeybindingWeight } from "../../../../platform/keybinding/common/keybindingsRegistry.js";
import { ActiveEditorContext } from "../../../../workbench/common/contextkeys.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import { ReviewCanvasEditorInput } from "./reviewCanvasEditorInput.js";
import { ReviewCanvasEditorPane } from "./reviewCanvasPart.js";

const REVIEW_FIND_COMMAND_ID = "review.action.find";

class ReviewFindAction extends Action2 {
  constructor() {
    super({
      id: REVIEW_FIND_COMMAND_ID,
      title: localize2("review.action.find", "Find in Review"),
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.KeyF,
        when: ActiveEditorContext.isEqualTo(ReviewCanvasEditorInput.EDITOR_ID),
      },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const pane = accessor.get(IEditorService).activeEditorPane;
    if (pane instanceof ReviewCanvasEditorPane) {
      if (pane.showFind()) return;
    }
    await accessor.get(ICommandService).executeCommand("actions.find");
  }
}

registerAction2(ReviewFindAction);
