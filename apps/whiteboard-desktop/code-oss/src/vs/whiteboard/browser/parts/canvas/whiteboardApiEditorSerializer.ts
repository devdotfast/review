import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IEditorSerializer } from "../../../../workbench/common/editor.js";
import type { EditorInput } from "../../../../workbench/common/editor/editorInput.js";
import { IWhiteboardCanvasEditorTabsService } from "../../../services/whiteboardCanvasEditorTabsService.js";
import { WhiteboardCanvasEditorInput } from "./whiteboardCanvasEditorInput.js";

/** Let the workbench persist API tab order, groups and focus alongside other editors. */
export class WhiteboardApiEditorSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput) {
    return editor instanceof WhiteboardCanvasEditorInput &&
      (editor.target.kind === "api" || editor.target.kind === "api-source" || editor.target.kind === "home");
  }

  serialize(editor: WhiteboardCanvasEditorInput) {
    return this.canSerialize(editor) ? JSON.stringify(editor.target) : undefined;
  }

  deserialize(instantiation: IInstantiationService, value: string) {
    let target;
    try { target = JSON.parse(value); } catch { return; }
    if (!target || !["api", "api-source", "home"].includes(target.kind)) return;
    // Restore old saved editor state once; serialize() writes only session IDs.
    for (const record of [target, target.selection]) {
      if (record && typeof record === "object" && "reviewId" in record) {
        if ("sessionId" in record) return;
        record.sessionId = record.reviewId;
        delete record.reviewId;
      }
    }
    if (target.kind !== "home" && (typeof target.sessionId !== "string" || typeof target.title !== "string")) return;
    if (target.kind === "api-source") {
      // Main already persists version-based Source tabs. Translate directly;
      // intermediate development-only view/generation payloads need no adapter.
      if (!target.selection && Number.isInteger(target.version) && target.version >= 0)
        target = { kind: target.kind, sessionId: target.sessionId, title: target.title,
          selection: { sessionId: target.sessionId, kind: "version", version: target.version } };
      const selection = target.selection;
      if (!selection || selection.sessionId !== target.sessionId ||
          !["current", "version"].includes(selection.kind) ||
          (selection.kind === "version" && (!Number.isInteger(selection.version) || selection.version < 0))) return;

    }
    return instantiation.invokeFunction(accessor => accessor.get(IWhiteboardCanvasEditorTabsService).inputFor(target));
  }
}
