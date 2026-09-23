/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from "../../base/common/lifecycle.js";
import {
  getWindow,
  scheduleAtNextAnimationFrame,
} from "../../base/browser/dom.js";
import { KeyCode, KeyMod } from "../../base/common/keyCodes.js";
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import { SymbolNavigationAnchor } from "../../editor/contrib/gotoSymbol/browser/goToCommands.js";
import { EditorContextKeys } from "../../editor/common/editorContextKeys.js";
import { Position } from "../../editor/common/core/position.js";
import { CommandsRegistry, ICommandService } from "../../platform/commands/common/commands.js";
import { ContextKeyExpr, RawContextKey } from "../../platform/contextkey/common/contextkey.js";
import {
  KeybindingsRegistry,
  KeybindingWeight,
} from "../../platform/keybinding/common/keybindingsRegistry.js";
import type { IEditorOptions } from "../../platform/editor/common/editor.js";
import { IHistoryService } from "../../workbench/services/history/common/history.js";
import {
  EditorPaneSelectionCompareResult,
  type IEditorPaneSelection,
} from "../../workbench/common/editor.js";

export const WhiteboardEmbeddedEditorFocus = new RawContextKey<boolean>(
  "whiteboardEmbeddedEditorFocus",
  false,
);

const whiteboardEmbeddedEditors = new WeakSet<ICodeEditor>();

export interface WhiteboardEmbeddedNavigationLocation {
  readonly view: "review" | "diff";
  readonly path: string;
  readonly side: "base" | "head";
  readonly lineNumber: number;
  readonly column: number;
  readonly section?: string;
}

interface WhiteboardEmbeddedEditorOptions extends IEditorOptions {
  readonly whiteboardEmbeddedSelection?: WhiteboardEmbeddedEditorSelection;
}

export function markWhiteboardEmbeddedEditor(editor: ICodeEditor): IDisposable {
  whiteboardEmbeddedEditors.add(editor);
  const focus = WhiteboardEmbeddedEditorFocus.bindTo(editor.contextKeyService);
  focus.set(true);
  return {
    dispose: () => {
      whiteboardEmbeddedEditors.delete(editor);
      focus.reset();
    },
  };
}

export class WhiteboardEmbeddedEditorSelection implements IEditorPaneSelection {
  constructor(
    readonly editor: ICodeEditor,
    readonly location: WhiteboardEmbeddedNavigationLocation,
  ) {}

  compare(other: IEditorPaneSelection): EditorPaneSelectionCompareResult {
    if (!(other instanceof WhiteboardEmbeddedEditorSelection)) {
      return EditorPaneSelectionCompareResult.DIFFERENT;
    }
    const left = this.location;
    const right = other.location;
    return left.view === right.view &&
      left.path === right.path &&
      left.side === right.side &&
      left.lineNumber === right.lineNumber &&
      left.column === right.column &&
      left.section === right.section
      ? EditorPaneSelectionCompareResult.IDENTICAL
      : EditorPaneSelectionCompareResult.DIFFERENT;
  }

  restore(options: IEditorOptions): IEditorOptions {
    return {
      ...options,
      whiteboardEmbeddedSelection: this,
    } as WhiteboardEmbeddedEditorOptions;
  }

  restoreInCanvas(): boolean {
    const domNode = this.editor.getDomNode();
    if (!domNode?.isConnected || !this.editor.hasModel()) return false;
    const restore = () => {
      const position = new Position(
        this.location.lineNumber,
        this.location.column,
      );
      const section = domNode.closest<HTMLElement>("[data-whiteboard-section]");
      section?.dispatchEvent(new CustomEvent("whiteboard-section-expand"));
      domNode.scrollIntoView({ block: "center", inline: "nearest" });
      this.editor.setPosition(position, "review.navigationHistory");
      this.editor.revealPositionInCenterIfOutsideViewport(position);
      this.editor.focus();
    };
    restore();
    scheduleAtNextAnimationFrame(getWindow(domNode), restore);
    return true;
  }

  log(): string {
    const location = this.location;
    return `${location.view}:${location.side}:${location.path}:${location.lineNumber}:${location.column}`;
  }
}

export function whiteboardEmbeddedSelectionFromOptions(
  options: IEditorOptions | undefined,
): WhiteboardEmbeddedEditorSelection | undefined {
  return (options as WhiteboardEmbeddedEditorOptions | undefined)
    ?.whiteboardEmbeddedSelection;
}

const goToDefinitionCommand = "review.action.embeddedGoToDefinition";
const showReferencesCommand = "review.action.embeddedShowReferences";

CommandsRegistry.registerCommand(goToDefinitionCommand, (accessor) => {
  runEmbeddedSymbolCommand(
    accessor.get(ICodeEditorService),
    accessor.get(IHistoryService),
    accessor.get(ICommandService),
    "editor.action.revealDefinition",
    true,
  );
});
CommandsRegistry.registerCommand(showReferencesCommand, (accessor) => {
  runEmbeddedSymbolCommand(
    accessor.get(ICodeEditorService),
    accessor.get(IHistoryService),
    accessor.get(ICommandService),
    "editor.action.referenceSearch.trigger",
    false,
  );
});

KeybindingsRegistry.registerKeybindingRule({
  id: goToDefinitionCommand,
  weight: KeybindingWeight.WorkbenchContrib,
  primary: KeyCode.F12,
  when: ContextKeyExpr.and(
    WhiteboardEmbeddedEditorFocus,
    EditorContextKeys.editorTextFocus,
  ),
});
KeybindingsRegistry.registerKeybindingRule({
  id: showReferencesCommand,
  weight: KeybindingWeight.WorkbenchContrib,
  primary: KeyMod.Shift | KeyCode.F12,
  when: ContextKeyExpr.and(
    WhiteboardEmbeddedEditorFocus,
    EditorContextKeys.editorTextFocus,
  ),
});

function runEmbeddedSymbolCommand(
  codeEditorService: ICodeEditorService,
  historyService: IHistoryService,
  commandService: ICommandService,
  commandId: string,
  recordsHistory: boolean,
): void {
  const editor = codeEditorService.getActiveCodeEditor();
  if (!editor || !whiteboardEmbeddedEditors.has(editor) || !editor.hasModel()) return;
  const model = editor.getModel();
  const position = editor.getPosition();
  editor.focus();
  if (recordsHistory) {
    historyService.addActiveEditorNavigation();
  }
  void commandService.executeCommand(
    commandId,
    new SymbolNavigationAnchor(model, position),
  );
}
