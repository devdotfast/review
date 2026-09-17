import { sourceLocation } from "../../../common/reviewSourceView.js";
import { URI } from "../../../../base/common/uri.js";
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
      if (!target.view) {
        if (!Number.isInteger(target.version) || target.version < 0) return;
        const query = new URLSearchParams({ version: String(target.version) });
        if (target.generation) query.set("generation", target.generation);
        if (target.live) query.set("live", "true");
        target = { kind: target.kind, reviewId: target.reviewId, title: target.title,
          view: sourceLocation(URI.from({ scheme: "review-api-source", authority: target.reviewId, query: query.toString() })).view };
      }
      if (!Number.isInteger(target.view.version) || target.view.version < 0 ||
          target.view.reviewId !== target.reviewId ||
          !["current", "version"].includes(target.view.selection) ||
          !["local", "retained"].includes(target.view.access)) return;
    }
    return instantiation.invokeFunction(accessor => accessor.get(IReviewCanvasEditorTabsService).inputFor(target));
  }
}
