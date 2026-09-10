/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../base/common/lifecycle.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { CodeEditorWidget } from "../../editor/browser/widget/codeEditor/codeEditorWidget.js";
import { EditorOption } from "../../editor/common/config/editorOptions.js";
import { Range } from "../../editor/common/core/range.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import type { ReviewCommitScope } from "../common/reviewProtocol.js";
import { IReviewCodeResourceService } from "./reviewCodeResourceService.js";
import { markReviewEmbeddedEditor } from "./reviewEmbeddedNavigation.js";

/** A selectable base/head row model for a virtualized file in unified layout. */
export class ReviewUnifiedFilesEditor extends Disposable {
  readonly editor: CodeEditorWidget;
  readonly changedRanges: Range[] = [];

  constructor(
    container: HTMLElement,
    overflowWidgetsDomNode: HTMLElement | undefined,
    path: string,
    scope: ReviewCommitScope | undefined,
    @IInstantiationService instantiationService: IInstantiationService,
    @IReviewCodeResourceService resources: IReviewCodeResourceService,
  ) {
    super();
    container.classList.add("review-inline-unified-diff");
    this.editor = this._register(
      instantiationService.createInstance(
        CodeEditorWidget,
        container,
        {
          overflowWidgetsDomNode,
          fixedOverflowWidgets: true,
          readOnly: true,
          minimap: { enabled: false },
          stickyScroll: { enabled: false },
          folding: false,
          glyphMargin: false,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          scrollbar: {
            vertical: "hidden",
            horizontal: "hidden",
            handleMouseWheel: false,
            useShadows: false,
          },
          padding: { top: 0, bottom: 0 },
        },
        {},
      ),
    );
    this._register(markReviewEmbeddedEditor(this.editor));
    void resources
      .acquireUnifiedDiff(path, "head", [], scope)
      .then((reference) => {
        if (!reference) throw new Error(`Unified diff is unavailable: ${path}`);
        if (this._store.isDisposed) {
          reference.dispose();
          return;
        }
        this._register(reference);
        this.editor.updateOptions({
          lineNumbers: (line) =>
            String(reference.rows[line - 1]?.authorLine ?? line),
        });
        this.editor.setModel(reference.model);
        for (const row of reference.rows) {
          if (
            row.kind !== "unchanged" &&
            reference.rows[row.lineNumber - 2]?.kind === "unchanged"
          ) {
            this.changedRanges.push(
              new Range(row.lineNumber, 1, row.lineNumber, 1),
            );
          } else if (row.lineNumber === 1 && row.kind !== "unchanged") {
            this.changedRanges.push(new Range(1, 1, 1, 1));
          }
        }
        this.editor.createDecorationsCollection(
          reference.rows.flatMap((row) =>
            row.kind === "unchanged"
              ? []
              : [
                  {
                    range: new Range(
                      row.lineNumber,
                      1,
                      row.lineNumber,
                      Number.MAX_SAFE_INTEGER,
                    ),
                    options: {
                      description: `Review unified ${row.kind} line`,
                      isWholeLine: true,
                      className:
                        row.kind === "added" ? "line-insert" : "line-delete",
                      marginClassName:
                        row.kind === "added"
                          ? "gutter-insert"
                          : "gutter-delete",
                      lineNumberClassName:
                        row.kind === "added"
                          ? "review-unified-line-number-added"
                          : "review-unified-line-number-deleted",
                    },
                  },
                ],
          ),
        );
        // Keep context around each change. Each omitted region can be expanded
        // without replacing the model or losing the base/head row mapping.
        const hidden: Range[] = [];
        let start = 0;
        while (start < reference.rows.length) {
          if (reference.rows[start].kind !== "unchanged") {
            start++;
            continue;
          }
          let end = start;
          while (
            end < reference.rows.length &&
            reference.rows[end].kind === "unchanged"
          )
            end++;
          const first = start === 0 ? start : start + 3;
          const last = end === reference.rows.length ? end : end - 3;
          if (last - first > 3) hidden.push(new Range(first + 1, 1, last, 1));
          start = end;
        }
        this.editor.setHiddenAreas(hidden, this);
        this.editor.changeViewZones((accessor) => {
          for (const range of hidden.slice()) {
            const button = container.ownerDocument.createElement("button");
            button.className = "review-unified-expand-context";
            button.textContent = `${range.endLineNumber - range.startLineNumber + 1} hidden lines — expand`;
            const id = accessor.addZone({
              afterLineNumber: range.startLineNumber - 1,
              heightInLines: 1,
              domNode: button,
              showInHiddenAreas: true,
              suppressMouseDown: false,
            });
            button.onclick = () => {
              hidden.splice(hidden.indexOf(range), 1);
              this.editor.setHiddenAreas(hidden, this);
              this.editor.changeViewZones((zones) => zones.removeZone(id));
            };
            button.style.height = `${this.editor.getOption(EditorOption.lineHeight)}px`;
          }
        });
      })
      .catch((error) => {
        if (!this._store.isDisposed) onUnexpectedError(error);
      });
  }
}
