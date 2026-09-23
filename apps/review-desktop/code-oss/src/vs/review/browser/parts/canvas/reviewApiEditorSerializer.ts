import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IEditorSerializer } from "../../../../workbench/common/editor.js";
import type { EditorInput } from "../../../../workbench/common/editor/editorInput.js";
import { IReviewCanvasEditorTabsService } from "../../../services/reviewCanvasEditorTabsService.js";
import { ReviewCanvasEditorInput } from "./reviewCanvasEditorInput.js";

/** Let the workbench persist API tab order, groups and focus alongside other editors. */
export class ReviewApiEditorSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput) {
    return editor instanceof ReviewCanvasEditorInput &&
      (editor.target.kind === "api" || editor.target.kind === "api-source" || editor.target.kind === "home");
  }

  serialize(editor: ReviewCanvasEditorInput) {
    return this.canSerialize(editor) ? JSON.stringify(editor.target) : undefined;
  }

  deserialize(instantiation: IInstantiationService, value: string) {
    let target;
    try { target = JSON.parse(value); } catch { return; }
    if (!target || !["api", "api-source", "home"].includes(target.kind)) return;
    if (target.kind !== "home" && (typeof target.reviewId !== "string" || typeof target.title !== "string")) return;
    if (target.kind === "api-source") {
      // Main already persists version-based Source tabs. Translate directly;
      // intermediate development-only view/generation payloads need no adapter.
      if (!target.selection && Number.isInteger(target.version) && target.version >= 0)
        target = { kind: target.kind, reviewId: target.reviewId, title: target.title,
          selection: { reviewId: target.reviewId, kind: "version", version: target.version } };
      const selection = target.selection;
      if (!selection || selection.reviewId !== target.reviewId ||
          !["current", "version"].includes(selection.kind) ||
          (selection.kind === "version" && (!Number.isInteger(selection.version) || selection.version < 0))) return;

    }
    return instantiation.invokeFunction(accessor => accessor.get(IReviewCanvasEditorTabsService).inputFor(target));
  }
}
