/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import {
  IStorageService,
  StorageScope,
  StorageTarget,
} from "../../../../platform/storage/common/storage.js";
import {
  EditorPaneDescriptor,
  IEditorPaneRegistry,
} from "../../../../workbench/browser/editor.js";
import { EditorExtensions } from "../../../../workbench/common/editor.js";
import {
  IWorkbenchContribution,
  registerWorkbenchContribution2,
  WorkbenchPhase,
} from "../../../../workbench/common/contributions.js";
import { IEditorGroupsService } from "../../../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import {
  LifecyclePhase,
  ILifecycleService,
} from "../../../../workbench/services/lifecycle/common/lifecycle.js";
import { IReviewSessionService } from "../../../services/reviewSessionService.js";
import { IReviewCanvasEditorTabsService } from "../../../services/reviewCanvasEditorTabsService.js";
import { ReviewCanvasEditorInput } from "./reviewCanvasEditorInput.js";
import { ReviewCanvasEditorPane } from "./reviewCanvasPart.js";

const OPEN_REVIEW_TABS_STORAGE_KEY = "review.canvas.openTabs";

interface StoredReviewTabs {
  readonly open: readonly string[];
  readonly active?: string;
}

class ReviewCanvasEditorContribution
  extends Disposable
  implements IWorkbenchContribution
{
  static readonly ID = "workbench.contrib.devfast.reviewCanvasEditor";

  private restored = false;

  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IEditorGroupsService
    private readonly editorGroupsService: IEditorGroupsService,
    @ILifecycleService private readonly lifecycleService: ILifecycleService,
    @IStorageService private readonly storageService: IStorageService,
    @IReviewSessionService
    private readonly sessionService: IReviewSessionService,
    @IReviewCanvasEditorTabsService
    private readonly tabsService: IReviewCanvasEditorTabsService,
  ) {
    super();
    this._register(
      Registry.as<IEditorPaneRegistry>(
        EditorExtensions.EditorPane,
      ).registerEditorPane(
        EditorPaneDescriptor.create(
          ReviewCanvasEditorPane,
          ReviewCanvasEditorPane.ID,
          "Review",
        ),
        [new SyncDescriptor(ReviewCanvasEditorInput)],
      ),
    );
    this._register(
      this.editorService.onDidCloseEditor(({ editor }) => {
        if (!(editor instanceof ReviewCanvasEditorInput)) return;
        if (editor.target.kind !== "review") {
          void this.tabsService.openHome(true);
        }
      }),
    );
    this._register(
      sessionService.onDidDismissReview((uuid) => {
        void this.tabsService.closeReview(uuid);
      }),
    );
    this._register(
      sessionService.onDidDeleteReview((uuid) => {
        void this.tabsService.closeReview(uuid);
      }),
    );
    this._register(
      sessionService.onDidRegisterSession(({ session, background }) => {
        // A background open (the Source tab rooting its file tree) must not
        // surface the review document tab. The server stamps the intent on
        // the event itself, so there is no ordering to get right here.
        if (background) {
          return;
        }
        const active = this.editorService.activeEditor;
        void this.tabsService.openReview(
          session.reviewUuid,
          active instanceof ReviewCanvasEditorInput &&
            active.target.kind === "home",
        );
      }),
    );
    void this.lifecycleService
      .when(LifecyclePhase.Restored)
      .then(() => this.initialize());
  }

  private async initialize(): Promise<void> {
    await this.tabsService.openHome(true);
    await this.sessionService.initialize();
    await this.restoreTabs();
    this.restored = true;
    this._register(
      this.editorService.onDidEditorsChange(() => this.persistOpenTabs()),
    );
    this._register(
      this.lifecycleService.onWillShutdown(() => {
        this.persistOpenTabs();
        this.restored = false;
      }),
    );
  }

  private async restoreTabs(): Promise<void> {
    const stored = this.readStoredTabs();
    const available = new Set(
      this.sessionService.reviews.map((review) => review.uuid),
    );
    for (const reviewUuid of stored.open) {
      if (!available.has(reviewUuid)) continue;
      await this.tabsService.openReview(
        reviewUuid,
        reviewUuid === stored.active,
      );
    }
  }

  private readStoredTabs(): StoredReviewTabs {
    const value = this.storageService.get(
      OPEN_REVIEW_TABS_STORAGE_KEY,
      StorageScope.APPLICATION,
    );
    if (!value) return { open: [] };
    try {
      const candidate = JSON.parse(value) as {
        open?: unknown;
        active?: unknown;
      };
      if (
        !Array.isArray(candidate.open) ||
        !candidate.open.every((uuid) => typeof uuid === "string") ||
        (candidate.active !== undefined &&
          typeof candidate.active !== "string")
      ) {
        return { open: [] };
      }
      const open = [...new Set(candidate.open)];
      return {
        open,
        ...(candidate.active && open.includes(candidate.active)
          ? { active: candidate.active }
          : {}),
      };
    } catch {
      return { open: [] };
    }
  }

  private persistOpenTabs(): void {
    if (!this.restored) return;
    const group = this.editorGroupsService.mainPart.activeGroup;
    const open = group.editors.flatMap((editor) =>
      editor instanceof ReviewCanvasEditorInput &&
      editor.target.kind === "review"
        ? [editor.target.reviewUuid]
        : [],
    );
    const activeEditor = group.activeEditor;
    const active =
      activeEditor instanceof ReviewCanvasEditorInput &&
      activeEditor.target.kind === "review"
        ? activeEditor.target.reviewUuid
        : undefined;
    this.storageService.store(
      OPEN_REVIEW_TABS_STORAGE_KEY,
      JSON.stringify({ open, ...(active ? { active } : {}) }),
      StorageScope.APPLICATION,
      StorageTarget.MACHINE,
    );
  }
}

registerWorkbenchContribution2(
  ReviewCanvasEditorContribution.ID,
  ReviewCanvasEditorContribution,
  WorkbenchPhase.BlockStartup,
);
